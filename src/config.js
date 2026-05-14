import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_TRANSLATE_DEPLOYMENT = "gpt-realtime-translate";
export const DEFAULT_WHISPER_DEPLOYMENT = "gpt-realtime-whisper";

export function loadDotEnv(filePath = resolve(process.cwd(), ".env")) {
  if (!existsSync(filePath)) {
    return {};
  }

  const values = {};
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

export function loadConfig(env = { ...loadDotEnv(), ...process.env }) {
  const endpoint = env.AZURE_OPENAI_ENDPOINT?.replace(/\/+$/, "");
  const apiKey = env.AZURE_OPENAI_API_KEY;

  if (!endpoint) {
    throw new Error("Missing required setting: AZURE_OPENAI_ENDPOINT");
  }

  if (!apiKey) {
    throw new Error("Missing required setting: AZURE_OPENAI_API_KEY");
  }

  return {
    endpoint,
    apiKey,
    translateDeployment:
      env.AZURE_OPENAI_TRANSLATE_DEPLOYMENT || DEFAULT_TRANSLATE_DEPLOYMENT,
    whisperDeployment:
      env.AZURE_OPENAI_WHISPER_DEPLOYMENT || DEFAULT_WHISPER_DEPLOYMENT,
    port: Number(env.PORT || 3000),
  };
}

export function buildTranslationSession(model, targetLanguage) {
  return {
    session: {
      model,
      audio: {
        output: {
          language: targetLanguage,
        },
      },
    },
  };
}

export function buildTranscriptionSession(model) {
  return {
    session: {
      type: "transcription",
      audio: {
        input: {
          transcription: {
            model,
          },
          turn_detection: {
            type: "server_vad",
          },
        },
      },
    },
  };
}

export function buildRealtimeUrl(endpoint, path) {
  return `${endpoint}/openai/v1/realtime/${path}?webrtcfilter=on`;
}

export function buildClientSecretUrl(endpoint, path = "client_secrets") {
  return `${endpoint}/openai/v1/realtime/${path}`;
}
