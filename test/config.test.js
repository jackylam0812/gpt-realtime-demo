import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildRealtimeUrl,
  buildTranslationSessionUpdate,
  buildTranslationWebSocketUrl,
  buildTranslationSession,
  buildTranscriptionSession,
  loadConfig,
} from "../src/config.js";

describe("loadConfig", () => {
  test("normalizes endpoint and keeps API key server-side", () => {
    const config = loadConfig({
      AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com/",
      AZURE_OPENAI_API_KEY: "secret",
    });

    assert.equal(config.endpoint, "https://example.openai.azure.com");
    assert.equal(config.apiKey, "secret");
    assert.equal(config.translateDeployment, "gpt-realtime-translate");
    assert.equal(config.whisperDeployment, "gpt-realtime-whisper");
  });

  test("rejects missing required Azure OpenAI settings", () => {
    assert.throws(() => loadConfig({}), /AZURE_OPENAI_ENDPOINT/);
    assert.throws(() =>
      loadConfig({
        AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
      }),
    /AZURE_OPENAI_API_KEY/);
  });
});

describe("session builders", () => {
  test("creates translation session payload for target language", () => {
    assert.deepEqual(buildTranslationSession("gpt-realtime-translate", "en"), {
      session: {
        model: "gpt-realtime-translate",
        audio: {
          output: {
            language: "en",
          },
        },
      },
    });
  });

  test("creates transcription session payload with whisper deployment", () => {
    assert.deepEqual(buildTranscriptionSession("gpt-realtime-whisper"), {
      session: {
        type: "transcription",
        audio: {
          input: {
            transcription: {
              model: "gpt-realtime-whisper",
            },
            turn_detection: {
              type: "server_vad",
            },
          },
        },
      },
    });
  });

  test("creates translation session.update event for WebSocket sessions", () => {
    assert.deepEqual(buildTranslationSessionUpdate("en"), {
      type: "session.update",
      session: {
        audio: {
          input: {
            transcription: {
              model: "gpt-realtime-whisper",
            },
          },
          output: {
            language: "en",
          },
        },
      },
    });
  });
});

describe("buildRealtimeUrl", () => {
  test("builds Azure OpenAI realtime call endpoints", () => {
    assert.equal(
      buildRealtimeUrl("https://example.openai.azure.com", "calls"),
      "https://example.openai.azure.com/openai/v1/realtime/calls?webrtcfilter=on",
    );

    assert.equal(
      buildRealtimeUrl("https://example.openai.azure.com", "translations/calls"),
      "https://example.openai.azure.com/openai/v1/realtime/translations/calls?webrtcfilter=on",
    );
  });

  test("builds Azure OpenAI translation WebSocket endpoint", () => {
    assert.equal(
      buildTranslationWebSocketUrl(
        "https://example.openai.azure.com",
        "gpt-realtime-translate",
      ),
      "wss://example.openai.azure.com/openai/v1/realtime/translations?model=gpt-realtime-translate",
    );
  });
});
