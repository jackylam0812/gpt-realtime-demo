import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

describe("translate client transport", () => {
  test("uses WebRTC media transport instead of browser WebSocket audio piping", async () => {
    const client = await readFile("public/realtime-client.js", "utf8");

    assert.match(client, /createOffer/);
    assert.match(client, /setRemoteDescription/);
    assert.doesNotMatch(client, /startTranslateWebSocketDemo/);
    assert.doesNotMatch(client, /new WebSocket/);
    assert.doesNotMatch(client, /createScriptProcessor/);
    assert.doesNotMatch(client, /playPcm16Audio/);
  });
});
