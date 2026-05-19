import {
  type G1ConnectionReadyMode,
  SmartglassesService,
  WebBluetoothG1Transport,
} from "../../../plugins/plugin-smartglasses/src/index.js";
import {
  createHardwareEvidenceReport,
  markHardwareMicrophoneCommand,
  recordHardwareAudio,
  recordHardwareEvent,
  recordHardwareWrite,
  updateHardwareEvidenceStatus,
} from "./hardware-evidence.js";

type BrowserWithBluetooth = Navigator & {
  bluetooth?: ConstructorParameters<typeof WebBluetoothG1Transport>[0];
};

const logEl = document.getElementById("log") as HTMLPreElement;
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

const service = new SmartglassesService();
let transport: WebBluetoothG1Transport | null = null;
const initMode: G1ConnectionReadyMode = new URLSearchParams(
  window.location.search,
).get("initMode") === "official"
  ? "official"
  : "lens-specific";
const report = createHardwareEvidenceReport({ initMode });
let initialized = false;

function log(message: string, data?: unknown): void {
  const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  logEl.textContent += `[${new Date().toLocaleTimeString()}] ${message}${suffix}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function updateReport(): void {
  updateHardwareEvidenceStatus(report, service.getStatus());
  window.smartglassesHardwareReport = report;
  log("evidence", {
    ok: report.ok,
    checks: report.checks,
    status: report.status,
  });
}

function reportJson(): string {
  updateHardwareEvidenceStatus(report, service.getStatus());
  report.finishedAt = new Date().toISOString();
  window.smartglassesHardwareReport = report;
  return `${JSON.stringify(report, null, 2)}\n`;
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
  const originalOpenMicrophone = nextTransport.openMicrophone.bind(
    nextTransport,
  );
  nextTransport.openMicrophone = async (enabled) => {
    markHardwareMicrophoneCommand(report, enabled);
    await originalOpenMicrophone(enabled);
  };
}

function setConnected(enabled: boolean): void {
  connectLeftButton.disabled = enabled;
  connectRightButton.disabled = enabled;
  disconnectButton.disabled = !enabled;
  displayButton.disabled = !enabled;
  clearButton.disabled = !enabled;
  micOnButton.disabled = !enabled;
  micOffButton.disabled = !enabled;
  settingsButton.disabled = !enabled;
  finalizeReportButton.disabled = !enabled;
  copyReportButton.disabled = !enabled;
  downloadReportButton.disabled = !enabled;
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
    report.checks.connected = true;
    await service.sendConnectionReady("both", initMode);
    await service.requestSerial("both");
    setConnected(true);
    log("connected", service.getStatus());
    updateReport();
  } catch (error) {
    initialized = false;
    log("initialize failed", String(error));
  }
}

async function connectLens(side: "left" | "right"): Promise<void> {
  try {
    const nextTransport = getOrCreateTransport();
    await withTimeout(
      nextTransport.connectLens(side),
      15_000,
      `${side} lens connection timed out`,
    );
    log(`${side} connected`);
    await initializeIfReady();
  } catch (error) {
    log(`${side} connect failed`, String(error));
  }
}

connectLeftButton.addEventListener("click", () => {
  void connectLens("left");
});

connectRightButton.addEventListener("click", () => {
  void connectLens("right");
});

disconnectButton.addEventListener("click", async () => {
  await service.disconnect();
  initialized = false;
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
  await service.setBrightness(10, true);
  await service.setDashboard(true, 4);
  await service.setHeadUpAngle(20);
  await service.setGlassesWearDetection(true);
  log("settings sent");
  updateReport();
});

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

log("ready", { initMode });

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
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
