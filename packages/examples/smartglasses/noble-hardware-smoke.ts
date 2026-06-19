import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  NobleG1Transport,
  SmartglassesService,
} from "@elizaos/plugin-facewear";
import {
  createHardwareEvidenceReport,
  markHardwareMicrophoneCommand,
  missingCompleteHardwareEvidence,
  recordHardwareAudio,
  recordHardwareEvent,
  recordHardwareWrite,
  updateHardwareEvidenceStatus,
} from "./hardware-evidence.js";

const scanTimeoutMs = Number(
  process.env.SMARTGLASSES_SCAN_TIMEOUT_MS ?? 20_000,
);
const holdMs = Number(process.env.SMARTGLASSES_HOLD_MS ?? 60_000);
const wearingTimeoutMs = Number(
  process.env.SMARTGLASSES_WEARING_TIMEOUT_MS ?? 30_000,
);
const directMicMs = Number(process.env.SMARTGLASSES_DIRECT_MIC_MS ?? 0);
const reportPath = process.env.SMARTGLASSES_REPORT_PATH;
const requestedInitMode = process.env.SMARTGLASSES_INIT_MODE;
const initMode =
  requestedInitMode === "official" || requestedInitMode === "android-f4"
    ? requestedInitMode
    : "lens-specific";

const report = createHardwareEvidenceReport({
  scanTimeoutMs,
  holdMs,
  initMode,
});

const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;

async function loadNoble() {
  try {
    const mod = (await dynamicImport("@abandonware/noble")) as {
      default?: unknown;
    };
    return mod.default ?? mod;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No native build was found")) {
      throw new Error(
        `@abandonware/noble is installed, but its native BLE binding is unavailable for this runtime: ${message}`,
        { cause: error },
      );
    }
    throw new Error(
      "Missing optional dependency @abandonware/noble. Install plugin optional dependencies before running Node BLE hardware smoke.",
      { cause: error },
    );
  }
}

function log(message: string, data?: unknown): void {
  const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  console.log(`[smartglasses:noble-smoke] ${message}${suffix}`);
}

const service = new SmartglassesService();

async function configureNobleTransport(): Promise<void> {
  const noble = await loadNoble();
  const transport = new NobleG1Transport(noble as never, { scanTimeoutMs });
  service.setTransport(transport);

  const originalWrite = transport.write.bind(transport);
  transport.write = async (side, data) => {
    recordHardwareWrite(report, side, data);
    await originalWrite(side, data);
  };
  const originalWriteBoth = transport.writeBoth.bind(transport);
  transport.writeBoth = async (data) => {
    recordHardwareWrite(report, "both", data);
    await originalWriteBoth(data);
  };
  const originalOpenMicrophone = transport.openMicrophone.bind(transport);
  transport.openMicrophone = async (enabled) => {
    markHardwareMicrophoneCommand(report, enabled);
    await originalOpenMicrophone(enabled);
  };

  service.onRawAudio((audio, sampleRate, side, encoding, sequence) => {
    recordHardwareAudio(report, audio, sampleRate, side, encoding, sequence);
    log("audio", {
      side,
      sampleRate,
      encoding,
      sequence,
      bytes: audio.length,
    });
  });
  transport.onEvent((event) => {
    recordHardwareEvent(report, event);
    log("event", {
      side: event.side,
      type: event.type,
      label: event.label,
      serialNumber: event.serialNumber,
    });
  });
}

async function waitForWearing(): Promise<void> {
  if (wearingTimeoutMs <= 0) return;
  updateHardwareEvidenceStatus(report, service.getStatus());
  if (report.headsetState.physical === "wearing") return;
  log(
    "action required",
    "remove the glasses from the charging base and wear them before tap/audio validation",
  );
  const deadline = Date.now() + wearingTimeoutMs;
  while (Date.now() < deadline) {
    updateHardwareEvidenceStatus(report, service.getStatus());
    if (report.headsetState.physical === "wearing") {
      log("wearing observed", report.headsetState);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    "Glasses did not report wearing state before tap/audio validation",
  );
}

async function runDirectMicDiagnostic(): Promise<void> {
  if (directMicMs <= 0) return;
  log(
    "direct mic diagnostic",
    "speak clearly until the diagnostic window ends",
  );
  await service.setMicrophoneEnabled(true);
  const deadline = Date.now() + directMicMs;
  while (Date.now() < deadline) {
    updateHardwareEvidenceStatus(report, service.getStatus());
    if (report.checks.audioObserved) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await service.setMicrophoneEnabled(false);
}

async function runTapAudioValidation(): Promise<void> {
  await service.setMicrophoneEnabled(false);
  log("mic disabled; single tap to enable, speak, then double tap to disable", {
    holdMs,
  });
  const deadline = Date.now() + holdMs;
  while (Date.now() < deadline) {
    updateHardwareEvidenceStatus(report, service.getStatus());
    if (missingCompleteHardwareEvidence(report).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await service.setMicrophoneEnabled(false);
  log("mic disabled");
}

try {
  await configureNobleTransport();
  log("scanning", { scanTimeoutMs });
  await service.connect();
  report.checks.connected = true;
  log("connected", service.getStatus());

  await service.sendConnectionReady("both", initMode);
  log("connection ready sent", { initMode });

  await service.requestSerial("both");
  log("serial requested");

  const display = await service.displayText(
    "Eliza smartglasses Node BLE smoke test. Single tap enables microphone. Double tap disables it.",
  );
  log("display sent", display);

  await service.setBrightness(10, true);
  await service.setDashboard(true, 4);
  await service.setHeadUpAngle(20);
  await service.setGlassesWearDetection(true);
  log("settings sent");

  await waitForWearing();
  await runDirectMicDiagnostic();
  await runTapAudioValidation();

  updateHardwareEvidenceStatus(report, service.getStatus());
  const missingChecks = missingCompleteHardwareEvidence(report);
  if (missingChecks.length > 0)
    throw new Error(
      `Missing hardware smoke evidence: ${missingChecks.join(", ")}`,
    );

  log("pass", { checks: report.checks, status: report.status });
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  updateHardwareEvidenceStatus(report, service.getStatus());
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  if (reportPath) {
    try {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      log("report written", { reportPath });
    } catch (error) {
      log("report write failed", {
        reportPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await service.disconnect().catch((error) => {
    log("disconnect failed", String(error));
  });
}
