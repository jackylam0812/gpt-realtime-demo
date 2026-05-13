# Azure OpenAI Realtime Demos

Two small browser demos for Azure OpenAI Realtime:

- `gpt-realtime-translate`: microphone audio in, translated speech out.
- `gpt-realtime-whisper`: microphone audio in, live transcription events out.

The browser never receives the Azure OpenAI API key. The local Node server creates short-lived Realtime client secrets for Whisper, proxies the Azure translation WebSocket for Translate, and serves the static pages.

## Run

1. Copy `.env.example` to `.env`.
2. Replace `AZURE_OPENAI_API_KEY` with your Azure OpenAI key.
3. Start the server:

```bash
npm start
```

If this machine does not have `npm`, run Node directly:

```bash
node src/server.js
```

Then open:

- `http://localhost:3000/translate.html`
- `http://localhost:3000/whisper.html`

## Configuration

```bash
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_TRANSLATE_DEPLOYMENT=gpt-realtime-translate
AZURE_OPENAI_WHISPER_DEPLOYMENT=gpt-realtime-whisper
PORT=3000
```

## Notes

- Browser microphone access requires `localhost` or HTTPS.
- The translation demo uses a local WebSocket proxy to Azure's `/openai/v1/realtime/translations?model=...` endpoint. It demonstrates speech-to-speech translation and avoids exposing the API key in the browser.
- The Whisper demo creates a transcription session and connects through the normal Realtime call endpoint.
- `.env` is ignored by git so keys are not committed.

## Diagnostics

To test only the translation WebSocket proxy:

```bash
node -e "const ws=new WebSocket('ws://localhost:3000/api/realtime/translate/ws?targetLanguage=en'); ws.onmessage=e=>{console.log(e.data); ws.close()}; ws.onopen=()=>console.log('open')"
```

To test the currently unsupported Azure translation client-secret call directly:

```bash
node scripts/check-translate-session.js en
```

If your shell does not have global `node`, use the bundled runtime path shown by Codex:

```bash
/Users/zhaohuilin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/check-translate-session.js en
```
