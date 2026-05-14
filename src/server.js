import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import {
  buildClientSecretUrl,
  buildRealtimeUrl,
  buildTranslationSession,
  buildTranscriptionSession,
  loadConfig,
} from "./config.js";

const PUBLIC_DIR = resolve(process.cwd(), "public");
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

let config;

try {
  config = loadConfig();
} catch (error) {
  console.error(error.message);
  console.error("Create a .env file from .env.example before starting the demo.");
  process.exit(1);
}

async function readJson(request) {
  let body = "";

  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) {
      throw httpError(413, "Request body is too large");
    }
  }

  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw httpError(400, "Request body must be valid JSON");
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function createClientSecret(url, payload) {
  const azureResponse = await fetch(url, {
    method: "POST",
    headers: {
      "api-key": config.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const contentType = azureResponse.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await azureResponse.json()
    : { message: await azureResponse.text() };

  if (!azureResponse.ok) {
    const detail = data.error?.message || data.message || "Azure OpenAI request failed";
    throw httpError(azureResponse.status, detail);
  }

  return data;
}

function normalizeLanguage(value) {
  const language = String(value || "en").trim().toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z]{2})?$/.test(language)) {
    throw httpError(400, "targetLanguage must be a BCP-47 language code, such as en or zh-cn");
  }

  return language;
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/config") {
    sendJson(response, 200, {
      endpoint: config.endpoint,
      translateDeployment: config.translateDeployment,
      whisperDeployment: config.whisperDeployment,
      whisperCallUrl: buildRealtimeUrl(config.endpoint, "calls"),
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/realtime/translate/session") {
    const body = await readJson(request);
    const targetLanguage = normalizeLanguage(body.targetLanguage);
    const payload = buildTranslationSession(config.translateDeployment, targetLanguage);
    const session = await createClientSecret(
      buildClientSecretUrl(config.endpoint, "translations/client_secrets"),
      payload,
    );

    sendJson(response, 200, {
      ...session,
      realtimeUrl: buildRealtimeUrl(config.endpoint, "translations/calls"),
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/realtime/whisper/session") {
    const payload = buildTranscriptionSession(config.whisperDeployment);
    const session = await createClientSecret(
      buildClientSecretUrl(config.endpoint),
      payload,
    );

    sendJson(response, 200, {
      ...session,
      realtimeUrl: buildRealtimeUrl(config.endpoint, "calls"),
    });
    return;
  }

  throw httpError(404, "Not found");
}

async function serveStatic(response, pathname) {
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const fileName = safePath === "/" ? "index.html" : safePath.replace(/^\/+/, "");
  const filePath = join(PUBLIC_DIR, fileName);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    throw httpError(403, "Forbidden");
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw httpError(404, "Not found");
    }

    throw error;
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url.pathname);
    } else {
      await serveStatic(response, url.pathname);
    }
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.message || "Internal server error",
    });
  }
});

server.listen(config.port, () => {
  console.log(`Azure OpenAI Realtime demos running at http://localhost:${config.port}`);
});
