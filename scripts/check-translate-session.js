import {
  buildClientSecretUrl,
  buildTranslationSession,
  loadConfig,
} from "../src/config.js";

const config = loadConfig();
const targetLanguage = process.argv[2] || "en";
const url = buildClientSecretUrl(config.endpoint, "translations/client_secrets");
const payload = buildTranslationSession(
  config.translateDeployment,
  targetLanguage,
);

console.log(`Endpoint: ${config.endpoint}`);
console.log(`Translate deployment: ${config.translateDeployment}`);
console.log(`Target language: ${targetLanguage}`);
console.log(`URL: ${url}`);
console.log(`Payload: ${JSON.stringify(payload)}`);

const response = await fetch(url, {
  method: "POST",
  headers: {
    "api-key": config.apiKey,
    "content-type": "application/json",
  },
  body: JSON.stringify(payload),
});

const body = await response.json().catch(async () => ({
  message: await response.text(),
}));

if (body.value) {
  body.value = "***REDACTED***";
}

if (body.client_secret?.value) {
  body.client_secret.value = "***REDACTED***";
}

console.log(`Status: ${response.status}`);
console.log(`apim-request-id: ${response.headers.get("apim-request-id") || ""}`);
console.log(`x-ms-region: ${response.headers.get("x-ms-region") || ""}`);
console.log(JSON.stringify(body, null, 2));

if (!response.ok) {
  process.exitCode = 1;
}
