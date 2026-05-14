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
      logEvent({ type: "demo.connected", demo, transport: "webrtc" });
      if (demo === "translate") {
        setAudioStatus("Listening for translated speech.", false);
      }
    });
    dataChannel.addEventListener("message", handleRealtimeMessage);
    dataChannel.addEventListener("close", () => setStatus("Closed"));

    if (elements.remoteAudio) {
      peerConnection.addEventListener("track", (event) => {
        elements.remoteAudio.srcObject = event.streams[0];
        elements.remoteAudio.play?.().catch(() => {});
        if (demo === "translate") {
          markTranslatedAudio();
        }
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
  dataChannel?.close();
  dataChannel = undefined;

  peerConnection?.close();
  peerConnection = undefined;

  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = undefined;

  elements.startButton.disabled = false;
  elements.stopButton.disabled = true;

  if (demo === "translate") {
    setAudioStatus("Waiting for translated audio.", false);
  }

  if (!options.keepStatus) {
    setStatus("Idle");
  }
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
    setAudioStatus("Listening for translated speech.", false);
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

  if (event.type === "output_audio_buffer.started") {
    markTranslatedAudio();
  }

  if (event.type === "output_audio_buffer.stopped") {
    setAudioStatus("Listening for translated speech.", false);
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
