import {
  type G1ConnectionReadyMode,
  SmartglassesService,
  WebBluetoothG1Transport,
} from "../../../plugins/plugin-facewear/src/index.js";
import {
  createHardwareEvidenceReport,
  headsetSetupHint,
  isCradleOrChargingState,
  markHardwareMicrophoneCommand,
  missingCompleteHardwareEvidence,
  recordHardwareAudio,
  recordHardwareEvent,
  recordHardwareWrite,
  updateHardwareEvidenceStatus,
} from "./hardware-evidence.js";

type BrowserWithBluetooth = Navigator & {
  bluetooth?: ConstructorParameters<typeof WebBluetoothG1Transport>[0];
};

const logEl = document.getElementById("log") as HTMLPreElement;
const connectHeadsetButton = document.getElementById(
  "connect-headset",
) as HTMLButtonElement;
const connectLeftButton = document.getElementById(
  "connect-left",
) as HTMLButtonElement;
const connectRightButton = document.getElementById(
  "connect-right",
) as HTMLButtonElement;
const disconnectButton = document.getElementById(
  "disconnect",
) as HTMLButtonElement;
const displayButton = document.getElementById("display") as HTMLButtonElement;
const clearButton = document.getElementById("clear") as HTMLButtonElement;
const micOnButton = document.getElementById("mic-on") as HTMLButtonElement;
const micOffButton = document.getElementById("mic-off") as HTMLButtonElement;
const settingsButton = document.getElementById("settings") as HTMLButtonElement;
const guidedValidationButton = document.getElementById(
  "guided-validation",
) as HTMLButtonElement;
const finalizeReportButton = document.getElementById(
  "finalize-report",
) as HTMLButtonElement;
const copyReportButton = document.getElementById(
  "copy-report",
) as HTMLButtonElement;
const downloadReportButton = document.getElementById(
  "download-report",
) as HTMLButtonElement;
const textArea = document.getElementById("text") as HTMLTextAreaElement;
const missingEl = document.getElementById("missing") as HTMLUListElement;
const headsetStateEl = document.getElementById(
  "headset-state",
) as HTMLDivElement;

const service = new SmartglassesService();
let transport: WebBluetoothG1Transport | null = null;
const initMode: G1ConnectionReadyMode = new URLSearchParams(
  window.location.search,
).get("initMode") as G1ConnectionReadyMode;
const effectiveInitMode: G1ConnectionReadyMode =
  initMode === "official" || initMode === "android-f4"
    ? initMode
    : "lens-specific";
const report = createHardwareEvidenceReport({ initMode: effectiveInitMode });
let initialized = false;
let connecting = false;
let headsetConnectStep: "left" | "right" = "left";
const headsetState: {
  physical: string | null;
  battery: string | null;
  device: string | null;
} = {
  physical: null,
  battery: null,
  device: null,
};

function log(message: string, data?: unknown): void {
  const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  logEl.textContent += `[${new Date().toLocaleTimeString()}] ${message}${suffix}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function updateReport(): void {
  updateHardwareEvidenceStatus(report, service.getStatus());
  window.smartglassesHardwareReport = report;
  renderMissingChecks();
  log("evidence", {
    ok: report.ok,
    checks: report.checks,
    status: report.status,
  });
}

function reportJson(): string {
  report.finishedAt = new Date().toISOString();
  updateHardwareEvidenceStatus(report, service.getStatus());
  window.smartglassesHardwareReport = report;
  renderMissingChecks();
  return `${JSON.stringify(report, null, 2)}\n`;
}

function renderMissingChecks(): void {
  const missing = missingCompleteHardwareEvidence(report);
  missingEl.replaceChildren(
    ...(missing.length === 0
      ? [document.createElement("li")]
      : missing.map((check) => {
          const item = document.createElement("li");
          item.textContent = check;
          return item;
        })),
  );
  if (missing.length === 0) {
    const completeItem = missingEl.firstElementChild;
    if (completeItem) {
      completeItem.textContent = "All required evidence captured";
    }
  }
}

function updateHeadsetState(event?: {
  stateCategory?: string;
  stateName?: string;
  label?: string;
}): void {
  if (event?.stateCategory === "physical") {
    headsetState.physical = event.stateName ?? event.label ?? null;
  } else if (event?.stateCategory === "battery") {
    headsetState.battery = event.stateName ?? event.label ?? null;
  } else if (event?.stateCategory === "device") {
    headsetState.device = event.stateName ?? event.label ?? null;
  }
  const states = [
    headsetState.physical,
    headsetState.battery,
    headsetState.device,
  ].filter(Boolean);
  const blocked = isCradleOrChargingState(
    headsetState.physical,
    headsetState.battery,
  );
  const ready = headsetState.physical === "wearing";
  const setupHint = headsetSetupHint({ headsetState });
  headsetStateEl.classList.toggle("warning", blocked);
  headsetStateEl.classList.toggle("ready", ready);
  headsetStateEl.textContent = `Headset state: ${
    states.join(" / ") || "no state yet"
  }. ${setupHint ?? "Wearing state observed; tap/audio validation can run."}`;
}

function instrumentTransport(nextTransport: WebBluetoothG1Transport): void {
  const originalWrite = nextTransport.write.bind(nextTransport);
  nextTransport.write = async (side, data) => {
    recordHardwareWrite(report, side, data);
    await originalWrite(side, data);
  };
  const originalWriteBoth = nextTransport.writeBoth.bind(nextTransport);
  nextTransport.writeBoth = async (data) => {
    recordHardwareWrite(report, "both", data);
    await originalWriteBoth(data);
  };
  const originalOpenMicrophone =
    nextTransport.openMicrophone.bind(nextTransport);
  nextTransport.openMicrophone = async (enabled) => {
    markHardwareMicrophoneCommand(report, enabled);
    await originalOpenMicrophone(enabled);
  };
}

function setConnected(enabled: boolean): void {
  connectHeadsetButton.disabled = enabled || connecting;
  connectHeadsetButton.textContent = enabled
    ? "Headset Connected"
    : headsetConnectStep === "left"
      ? "Connect Headset"
      : "Connect Headset Right";
  connectLeftButton.disabled = enabled || connecting;
  connectRightButton.disabled = enabled || connecting;
  connectLeftButton.hidden = !enabled && headsetConnectStep === "left";
  connectRightButton.hidden = !enabled && headsetConnectStep === "left";
  disconnectButton.disabled = !enabled;
  displayButton.disabled = !enabled;
  clearButton.disabled = !enabled;
  micOnButton.disabled = !enabled;
  micOffButton.disabled = !enabled;
  settingsButton.disabled = !enabled;
  guidedValidationButton.disabled = !enabled;
  finalizeReportButton.disabled = !enabled;
  copyReportButton.disabled = !enabled;
  downloadReportButton.disabled = !enabled;
}

function setConnecting(enabled: boolean): void {
  connecting = enabled;
  connectHeadsetButton.disabled = enabled;
  connectLeftButton.disabled = enabled;
  connectRightButton.disabled = enabled;
}

function getOrCreateTransport(): WebBluetoothG1Transport {
  if (transport) return transport;
  const browserNavigator = navigator as BrowserWithBluetooth;
  if (!browserNavigator.bluetooth) {
    throw new Error("Web Bluetooth is not available in this browser");
  }
  transport = new WebBluetoothG1Transport(browserNavigator.bluetooth);
  instrumentTransport(transport);
  transport.onEvent((event) => {
    updateHeadsetState(event);
    recordHardwareEvent(report, event);
    log("event", event);
    updateReport();
  });
  transport.onAudio((audioData, sampleRate, side, encoding, sequence) => {
    recordHardwareAudio(
      report,
      audioData,
      sampleRate,
      side,
      encoding,
      sequence,
    );
    updateReport();
    log("audio", {
      side,
      sampleRate,
      encoding,
      sequence,
      bytes: audioData.length,
    });
  });
  service.setTransport(transport);
  return transport;
}

async function initializeIfReady(): Promise<void> {
  if (!transport?.isConnected() || initialized) return;
  initialized = true;
  try {
    await service.connect();
    report.checks.connected = true;
    await service.sendConnectionReady("both", effectiveInitMode);
    await service.requestSerial("both");
    setConnected(true);
    log("connected", service.getStatus());
    updateReport();
  } catch (error) {
    initialized = false;
    log("initialize failed", String(error));
  }
}

async function connectLens(side: "left" | "right"): Promise<boolean> {
  try {
    const nextTransport = getOrCreateTransport();
    await withTimeout(
      nextTransport.connectLens(side),
      60_000,
      `${side} lens connection timed out`,
    );
    log(`${side} connected`);
    await initializeIfReady();
    return true;
  } catch (error) {
    log(`${side} connect failed`, String(error));
    return false;
  }
}

async function connectHeadset(): Promise<void> {
  setConnecting(true);
  try {
    const side = headsetConnectStep;
    log(
      "connect headset",
      side === "left"
        ? "Step 1 of 2: select the left lens. The same headset button will then prompt for the right lens."
        : "Select the right lens to complete the headset.",
    );
    const connected = await connectLens(side);
    if (connected && side === "left") headsetConnectStep = "right";
  } finally {
    setConnecting(false);
    setConnected(Boolean(transport?.isConnected()));
  }
}

connectHeadsetButton.addEventListener("click", () => {
  void connectHeadset();
});

connectLeftButton.addEventListener("click", () => {
  void connectLens("left");
});

connectRightButton.addEventListener("click", () => {
  void connectLens("right");
});

disconnectButton.addEventListener("click", async () => {
  await service.disconnect();
  initialized = false;
  headsetConnectStep = "left";
  setConnected(false);
  log("disconnected");
});

displayButton.addEventListener("click", async () => {
  const result = await service.displayText(textArea.value);
  log("display sent", result);
  updateReport();
});

clearButton.addEventListener("click", async () => {
  await service.clearDisplay();
  log("clear sent");
});

micOnButton.addEventListener("click", async () => {
  await service.setMicrophoneEnabled(true);
  log("mic enabled");
  updateReport();
});

micOffButton.addEventListener("click", async () => {
  await service.setMicrophoneEnabled(false);
  log("mic disabled");
  updateReport();
});

settingsButton.addEventListener("click", async () => {
  await sendSettings();
  log("settings sent");
  updateReport();
});

guidedValidationButton.addEventListener("click", async () => {
  await runGuidedValidation();
});

async function sendSettings(): Promise<void> {
  await service.setBrightness(10, true);
  await service.setDashboard(true, 4);
  await service.setHeadUpAngle(20);
  await service.setGlassesWearDetection(true);
}

async function runGuidedValidation(): Promise<void> {
  if (!transport?.isConnected()) {
    log("guided validation skipped", "Connect both lenses first");
    return;
  }
  updateHardwareEvidenceStatus(report, service.getStatus());
  if (
    isCradleOrChargingState(
      report.headsetState.physical,
      report.headsetState.battery,
    )
  ) {
    log("guided validation skipped", report.setupHint);
    renderMissingChecks();
    return;
  }
  guidedValidationButton.disabled = true;
  try {
    log(
      "guided validation",
      "sending display/settings; then single tap, speak, and double tap",
    );
    await service.setMicrophoneEnabled(false);
    await service.displayText(
      "Hardware validation: single tap, speak for audio, then double tap.",
    );
    await sendSettings();
    updateReport();
    log("action required", "single tap now, speak clearly, then double tap");

    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && !report.ok) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      updateHardwareEvidenceStatus(report, service.getStatus());
      renderMissingChecks();
      if (
        report.checks.tapObserved &&
        report.checks.microphoneEnabledByTap &&
        report.checks.audioObserved &&
        !report.checks.microphoneDisabledByTap
      ) {
        log("action required", "double tap now to disable microphone");
      }
    }

    await service.setMicrophoneEnabled(false);
    updateReport();
    const missing = missingCompleteHardwareEvidence(report);
    if (missing.length === 0) {
      log("guided validation pass", { checks: report.checks });
    } else {
      log("guided validation incomplete", { missing });
    }
  } catch (error) {
    log("guided validation failed", String(error));
  } finally {
    guidedValidationButton.disabled = false;
  }
}

finalizeReportButton.addEventListener("click", () => {
  const json = reportJson();
  log("final report", JSON.parse(json));
});

copyReportButton.addEventListener("click", async () => {
  const json = reportJson();
  await navigator.clipboard.writeText(json);
  log("report copied");
});

downloadReportButton.addEventListener("click", () => {
  const json = reportJson();
  const url = URL.createObjectURL(
    new Blob([json], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `smartglasses-hardware-report-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.json`;
  link.click();
  URL.revokeObjectURL(url);
  log("report download started", { filename: link.download });
});

log("ready", { initMode: effectiveInitMode });
renderMissingChecks();
updateHeadsetState();
setConnected(false);

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error(message)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

declare global {
  interface Window {
    smartglassesHardwareReport?: typeof report;
  }
}
