import { createHash } from "node:crypto";
import {
  buildTranslationSessionUpdate,
  buildTranslationWebSocketUrl,
} from "./config.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function handleTranslateWebSocketUpgrade(request, socket, head, config) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname !== "/api/realtime/translate/ws") {
    socket.destroy();
    return;
  }

  let targetLanguage;
  try {
    targetLanguage = normalizeLanguage(url.searchParams.get("targetLanguage"));
  } catch {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const acceptKey = createHash("sha1")
    .update(`${key}${WS_GUID}`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "\r\n",
    ].join("\r\n"),
  );

  if (head?.length) {
    socket.unshift(head);
  }

  connectAzureTranslationWebSocket(socket, config, targetLanguage);
}

function connectAzureTranslationWebSocket(clientSocket, config, targetLanguage) {
  const azureUrl = buildTranslationWebSocketUrl(
    config.endpoint,
    config.translateDeployment,
  );
  const azureSocket = new WebSocket(azureUrl, {
    headers: {
      "api-key": config.apiKey,
    },
  });

  let clientBuffer = Buffer.alloc(0);
  const pendingMessages = [];

  azureSocket.addEventListener("open", () => {
    azureSocket.send(JSON.stringify(buildTranslationSessionUpdate(targetLanguage)));
    while (pendingMessages.length > 0) {
      azureSocket.send(pendingMessages.shift());
    }
    sendTextFrame(clientSocket, JSON.stringify({ type: "proxy.connected" }));
  });

  azureSocket.addEventListener("message", (event) => {
    sendTextFrame(clientSocket, String(event.data));
  });

  azureSocket.addEventListener("error", () => {
    sendTextFrame(
      clientSocket,
      JSON.stringify({
        type: "proxy.error",
        message: "Azure translation WebSocket error",
      }),
    );
  });

  azureSocket.addEventListener("close", (event) => {
    sendTextFrame(
      clientSocket,
      JSON.stringify({
        type: "proxy.closed",
        code: event.code,
        reason: event.reason,
      }),
    );
    closeSocket(clientSocket);
  });

  clientSocket.on("data", (chunk) => {
    clientBuffer = Buffer.concat([clientBuffer, chunk]);
    const result = readFrames(clientBuffer);
    clientBuffer = result.rest;

    for (const frame of result.frames) {
      if (frame.opcode === 0x8) {
        azureSocket.close();
        closeSocket(clientSocket);
        return;
      }

      if (frame.opcode !== 0x1) {
        continue;
      }

      const text = frame.payload.toString("utf8");
      if (azureSocket.readyState === WebSocket.OPEN) {
        azureSocket.send(text);
      } else {
        pendingMessages.push(text);
      }
    }
  });

  clientSocket.on("close", () => {
    azureSocket.close();
  });

  clientSocket.on("error", () => {
    azureSocket.close();
  });
}

function readFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) === 0x80;
    let length = second & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      const longLength = buffer.readBigUInt64BE(cursor);
      if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("WebSocket frame is too large");
      }
      length = Number(longLength);
      cursor += 8;
    }

    const maskLength = masked ? 4 : 0;
    if (buffer.length - cursor < maskLength + length) {
      break;
    }

    let payload = buffer.subarray(cursor + maskLength, cursor + maskLength + length);
    if (masked) {
      const mask = buffer.subarray(cursor, cursor + 4);
      payload = Buffer.from(payload);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }

    frames.push({ opcode, payload });
    offset = cursor + maskLength + length;
  }

  return {
    frames,
    rest: buffer.subarray(offset),
  };
}

function sendTextFrame(socket, text) {
  if (socket.destroyed) {
    return;
  }

  const payload = Buffer.from(text, "utf8");
  let header;

  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  socket.write(Buffer.concat([header, payload]));
}

function closeSocket(socket) {
  if (!socket.destroyed) {
    socket.end();
  }
}

function normalizeLanguage(value) {
  const language = String(value || "en").trim().toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z]{2})?$/.test(language)) {
    throw new Error("Invalid target language");
  }

  return language;
}
