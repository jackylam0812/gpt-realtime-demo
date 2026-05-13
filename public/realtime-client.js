const body = document.body;
const demo = body.dataset.demo;

const elements = {
  status: document.querySelector("#status"),
  startButton: document.querySelector("#startButton"),
  stopButton: document.querySelector("#stopButton"),
  targetLanguage: document.querySelector("#targetLanguage"),
  sourceTranscript: document.querySelector("#sourceTranscript"),
  translatedTranscript: document.querySelector("#translatedTranscript"),
  audioPulse: document.querySelector("#audioPulse"),
  audioStatus: document.querySelector("#audioStatus"),
  eventLog: document.querySelector("#eventLog"),
  remoteAudio: document.querySelector("#remoteAudio"),
  clearSource: document.querySelector("#clearSource"),
  clearTranslated: document.querySelector("#clearTranslated"),
  clearEvents: document.querySelector("#clearEvents"),
};

let peerConnection;
let dataChannel;
let mediaStream;
let translateSocket;
let audioContext;
let microphoneSource;
let microphoneProcessor;
let playbackTime = 0;
let sourceBuffer = "";
let translatedBuffer = "";
let sourceDelta = "";
let translatedDelta = "";

elements.startButton?.addEventListener("click", startDemo);
elements.stopButton?.addEventListener("click", stopDemo);
elements.clearSource?.addEventListener("click", () => {
  sourceBuffer = "";
  sourceDelta = "";
  renderTranscript("source");
});
elements.clearTranslated?.addEventListener("click", () => {
  translatedBuffer = "";
  translatedDelta = "";
  renderTranscript("translated");
});
elements.clearEvents?.addEventListener("click", () => {
  elements.eventLog.textContent = "";
});

async function startDemo() {
  if (demo === "translate") {
    await startTranslateWebSocketDemo();
    return;
  }

  setStatus("Requesting microphone");
  elements.startButton.disabled = true;
  elements.stopButton.disabled = false;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    const session = await createSession();
    const clientSecret = extractClientSecret(session);
    if (!clientSecret) {
      throw new Error("Client secret was not returned by Azure OpenAI.");
    }

    peerConnection = new RTCPeerConnection();
    dataChannel = peerConnection.createDataChannel("oai-events");
    dataChannel.addEventListener("open", () => {
      setStatus("Connected", "connected");
      logEvent({ type: "demo.connected", demo });
    });
    dataChannel.addEventListener("message", handleRealtimeMessage);
    dataChannel.addEventListener("close", () => setStatus("Closed"));

    if (elements.remoteAudio) {
      peerConnection.addEventListener("track", (event) => {
        elements.remoteAudio.srcObject = event.streams[0];
      });
    }

    for (const track of mediaStream.getAudioTracks()) {
      peerConnection.addTrack(track, mediaStream);
    }

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    setStatus("Connecting to Azure");
    const answer = await fetch(session.realtimeUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${clientSecret}`,
        "content-type": "application/sdp",
      },
      body: offer.sdp,
    });

    if (!answer.ok) {
      throw new Error(await answer.text());
    }

    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: await answer.text(),
    });
  } catch (error) {
    logEvent({ type: "demo.error", message: error.message });
    setStatus(error.message, "error");
    stopDemo({ keepStatus: true });
  }
}

function stopDemo(options = {}) {
  stopTranslateWebSocket();

  dataChannel?.close();
  dataChannel = undefined;

  peerConnection?.close();
  peerConnection = undefined;

  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = undefined;

  elements.startButton.disabled = false;
  elements.stopButton.disabled = true;

  if (!options.keepStatus) {
    setStatus("Idle");
  }
}

async function startTranslateWebSocketDemo() {
  setStatus("Requesting microphone");
  elements.startButton.disabled = true;
  elements.stopButton.disabled = false;

  try {
    audioContext = new AudioContext({ sampleRate: 24000 });
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const targetLanguage = encodeURIComponent(elements.targetLanguage.value);
    translateSocket = new WebSocket(
      `${protocol}//${location.host}/api/realtime/translate/ws?targetLanguage=${targetLanguage}`,
    );

    translateSocket.addEventListener("open", () => {
      setStatus("Connected", "connected");
      startMicrophoneStreaming();
    });

    translateSocket.addEventListener("message", (message) => {
      const event = JSON.parse(message.data);
      logEvent(event);
      handleTranslationWebSocketEvent(event);
    });

    translateSocket.addEventListener("error", () => {
      setStatus("Translation WebSocket error", "error");
    });

    translateSocket.addEventListener("close", () => {
      stopTranslateWebSocket();
      setStatus("Idle");
    });
  } catch (error) {
    logEvent({ type: "demo.error", message: error.message });
    setStatus(error.message, "error");
    stopDemo({ keepStatus: true });
  }
}

function startMicrophoneStreaming() {
  microphoneSource = audioContext.createMediaStreamSource(mediaStream);
  microphoneProcessor = audioContext.createScriptProcessor(4096, 1, 1);

  microphoneProcessor.onaudioprocess = (event) => {
    if (translateSocket?.readyState !== WebSocket.OPEN) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);
    const pcm16 = floatToPcm16(input, event.inputBuffer.sampleRate, 24000);
    translateSocket.send(
      JSON.stringify({
        type: "session.input_audio_buffer.append",
        audio: arrayBufferToBase64(pcm16.buffer),
      }),
    );
  };

  microphoneSource.connect(microphoneProcessor);
  microphoneProcessor.connect(audioContext.destination);
}

function handleTranslationWebSocketEvent(event) {
  if (event.type === "proxy.connected") {
    return;
  }

  if (event.type === "proxy.error" || event.type === "error") {
    setStatus(event.message || event.error?.message || "Translation error", "error");
    return;
  }

  if (event.type === "session.input_transcript.delta") {
    applyTranscriptEvent("source", event);
    return;
  }

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    commitTranscript("source", event.transcript);
    return;
  }

  if (event.type === "session.output_transcript.delta") {
    applyTranscriptEvent("translated", event);
    return;
  }

  if (
    event.type === "session.output_transcript.done" ||
    event.type === "response.audio_transcript.done"
  ) {
    commitTranscript("translated", event.transcript);
    return;
  }

  if (event.type === "response.audio_transcript.delta") {
    applyTranscriptEvent("translated", event);
    return;
  }

  if (event.type === "session.output_audio.delta") {
    markTranslatedAudio();
    playPcm16Audio(event.delta);
  }
}

function stopTranslateWebSocket() {
  microphoneProcessor?.disconnect();
  microphoneProcessor = undefined;

  microphoneSource?.disconnect();
  microphoneSource = undefined;

  if (translateSocket?.readyState === WebSocket.OPEN) {
    translateSocket.close();
  }
  translateSocket = undefined;

  if (audioContext?.state !== "closed") {
    audioContext?.close();
  }
  audioContext = undefined;
  playbackTime = 0;
  setAudioStatus("Waiting for translated audio.", false);
}

async function createSession() {
  const endpoint =
    demo === "translate"
      ? "/api/realtime/translate/session"
      : "/api/realtime/whisper/session";

  const body =
    demo === "translate"
      ? { targetLanguage: elements.targetLanguage.value }
      : {};

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Unable to create Realtime session.");
  }

  return payload;
}

function extractClientSecret(session) {
  return (
    session.client_secret?.value ||
    session.client_secret ||
    session.value ||
    session.secret ||
    session.clientSecret
  );
}

function markTranslatedAudio() {
  setAudioStatus("Receiving translated speech.", true);
  window.clearTimeout(markTranslatedAudio.timeout);
  markTranslatedAudio.timeout = window.setTimeout(() => {
    setAudioStatus("Waiting for translated audio.", false);
  }, 900);
}

function setAudioStatus(text, active) {
  if (elements.audioStatus) {
    elements.audioStatus.textContent = text;
  }
  elements.audioPulse?.classList.toggle("active", active);
}

function handleRealtimeMessage(message) {
  const event = JSON.parse(message.data);
  logEvent(event);

  if (event.type === "error") {
    setStatus(event.error?.message || "Realtime error", "error");
    return;
  }

  if (
    event.type?.includes("input_audio_transcription") ||
    event.type?.includes("input_transcript")
  ) {
    applyTranscriptEvent("source", event);
    return;
  }

  if (
    event.type?.includes("audio_transcript") ||
    event.type?.includes("output_transcript") ||
    event.type?.includes("translation")
  ) {
    applyTranscriptEvent("translated", event);
  }
}

function applyTranscriptEvent(kind, event) {
  const finalText = event.transcript || event.text;
  if (event.type?.endsWith(".completed") || event.type?.endsWith(".done")) {
    commitTranscript(kind, finalText);
    return;
  }

  appendTranscriptDelta(kind, event.delta || finalText || "");
}

function appendTranscriptDelta(kind, text) {
  if (!text) return;
  if (kind === "source") {
    sourceDelta += text;
  } else {
    translatedDelta += text;
  }
  renderTranscript(kind);
}

function commitTranscript(kind, text) {
  if (!text) return;
  if (kind === "source") {
    sourceBuffer += `${text}\n`;
    sourceDelta = "";
  } else {
    translatedBuffer += `${text}\n`;
    translatedDelta = "";
  }
  renderTranscript(kind);
}

function renderTranscript(kind) {
  if (kind === "source" && elements.sourceTranscript) {
    elements.sourceTranscript.textContent = sourceBuffer + sourceDelta;
  }

  if (kind === "translated" && elements.translatedTranscript) {
    elements.translatedTranscript.textContent = translatedBuffer + translatedDelta;
  }
}

function setStatus(text, state) {
  elements.status.textContent = text;
  elements.status.classList.remove("connected", "error");
  if (state) {
    elements.status.classList.add(state);
  }
}

function logEvent(event) {
  const type = event.type || "event";
  const timestamp = new Date().toLocaleTimeString();
  const compact = { ...event };
  delete compact.audio;
  delete compact.response?.output;
  if (typeof compact.delta === "string" && compact.delta.length > 160) {
    compact.delta = `${compact.delta.slice(0, 160)}... (${compact.delta.length} chars)`;
  }

  elements.eventLog.textContent += `[${timestamp}] ${type}\n${JSON.stringify(compact, null, 2)}\n\n`;
  elements.eventLog.scrollTop = elements.eventLog.scrollHeight;
}

function floatToPcm16(float32, sourceRate, targetRate) {
  const samples =
    sourceRate === targetRate ? float32 : resampleFloat32(float32, sourceRate, targetRate);
  const pcm16 = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm16[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm16;
}

function resampleFloat32(input, sourceRate, targetRate) {
  const outputLength = Math.max(1, Math.round((input.length * targetRate) / sourceRate));
  const output = new Float32Array(outputLength);
  const ratio = (input.length - 1) / Math.max(1, outputLength - 1);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const before = Math.floor(sourceIndex);
    const after = Math.min(before + 1, input.length - 1);
    const weight = sourceIndex - before;
    output[index] = input[before] * (1 - weight) + input[after] * weight;
  }

  return output;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToInt16Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Int16Array(bytes.buffer);
}

function playPcm16Audio(base64Pcm16) {
  if (!audioContext || !base64Pcm16) {
    return;
  }

  const pcm16 = base64ToInt16Array(base64Pcm16);
  const audioBuffer = audioContext.createBuffer(1, pcm16.length, 24000);
  const channel = audioBuffer.getChannelData(0);

  for (let index = 0; index < pcm16.length; index += 1) {
    channel[index] = pcm16[index] / 0x8000;
  }

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);

  const startTime = Math.max(audioContext.currentTime, playbackTime);
  source.start(startTime);
  playbackTime = startTime + audioBuffer.duration;
}
