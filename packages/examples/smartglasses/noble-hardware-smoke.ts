import {
  type G1ConnectionReadyMode,
  NobleG1Transport,
  SmartglassesService,
} from "@elizaos/plugin-smartglasses";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createHardwareEvidenceReport,
  markHardwareMicrophoneCommand,
  missingHardwareEvidence,
  recordHardwareAudio,
  recordHardwareEvent,
  recordHardwareWrite,
  updateHardwareEvidenceStatus,
} from "./hardware-evidence.js";

const scanTimeoutMs = Number(
  process.env.SMARTGLASSES_SCAN_TIMEOUT_MS ?? 20_000,
);
const holdMs = Number(process.env.SMARTGLASSES_HOLD_MS ?? 5_000);
const reportPath = process.env.SMARTGLASSES_REPORT_PATH;
const initMode =
  process.env.SMARTGLASSES_INIT_MODE === "official"
    ? "official"
    : "lens-specific";

const report = createHardwareEvidenceReport({ scanTimeoutMs, holdMs, initMode });

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

const noble = await loadNoble();
const transport = new NobleG1Transport(noble as never, { scanTimeoutMs });
const service = new SmartglassesService();
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

try {
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

  await service.setMicrophoneEnabled(false);
  log("mic disabled; single tap to enable, speak, then double tap to disable", {
    holdMs,
  });
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  await service.setMicrophoneEnabled(false);
  log("mic disabled");

  updateHardwareEvidenceStatus(report, service.getStatus());
  const missingChecks = missingHardwareEvidence(report);
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
