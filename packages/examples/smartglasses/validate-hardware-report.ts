import { readFile } from "node:fs/promises";
import {
  type HardwareEvidenceReport,
  hardwarePhysicalBlocker,
  hardwareScanDiagnosis,
  missingCompleteHardwareEvidence,
  nextActionForHardwareBlocker,
  setupHintForHardwareBlocker,
} from "./hardware-evidence.js";
import {
  inspectLocalBluetoothPreflight,
  type LocalBluetoothPreflight,
} from "./hardware-local-bluetooth.js";

const VALIDATION_FAILURE_DESCRIPTIONS: Record<string, string> = {
  connected: "Both lenses must be connected as one headset.",
  connectionReadySent: "Connection-ready init packet must be sent.",
  displayPacketsSent: "At least one display packet must be sent.",
  serialRequested: "Serial-number request packet must be sent.",
  serialObserved: "Serial-number response must be observed.",
  settingsSent:
    "At least one settings packet must be sent: brightness, dashboard, head-up angle, or wear detection.",
  tapObserved: "A side-tap or long-press event must be observed.",
  microphoneEnabledByTap:
    "A single tap or long press must enable microphone input.",
  microphoneEnableWriteAfterTap:
    "A right-lens microphone-enable write must follow the enable tap event.",
  microphoneDisabledByTap:
    "A double tap or stop-recording event must disable microphone input.",
  microphoneDisableWriteAfterTap:
    "A right-lens microphone-disable write must follow the disable tap event.",
  audioObserved: "A microphone audio chunk must be received from the glasses.",
  missingFinishedAt: "The report was not finalized.",
  missingLeftLensConnection: "The left lens was not recorded as connected.",
  missingRightLensConnection: "The right lens was not recorded as connected.",
  missingStatusLeftLensConnection:
    "The final service status did not include a connected left lens.",
  missingStatusRightLensConnection:
    "The final service status did not include a connected right lens.",
  missingSerialNumber:
    "The final service status did not include the serial number.",
  missingStatusAudioChunks:
    "The final service status did not count any microphone audio chunks.",
  missingWrites: "No outgoing G1 packet writes were recorded.",
  missingEvents: "No incoming G1 events were recorded.",
  missingAudioChunks: "No microphone audio chunks were recorded.",
  missingInitWrite: "No connection-ready init write was recorded.",
  missingDisplayWrite: "No display-result write was recorded.",
  missingSerialRequestWrite: "No serial-number request write was recorded.",
  missingSettingsWrite:
    "No settings write was recorded: brightness, dashboard, head-up angle, or wear detection.",
  missingSerialEvent: "No serial-number event was observed.",
  missingMicEnableTapEvent:
    "No single-tap or long-press event was observed for microphone enable.",
  missingMicDisableTapEvent:
    "No double-tap or stop-recording event was observed for microphone disable.",
  missingMicEnableWrite: "No right-lens microphone-enable write was recorded.",
  missingMicDisableWrite:
    "No right-lens microphone-disable write was recorded.",
  missingMicEnableWriteAfterTap:
    "No right-lens microphone-enable write was recorded after a single-tap or long-press event.",
  missingMicDisableWriteAfterTap:
    "No right-lens microphone-disable write was recorded after a double-tap or stop-recording event.",
  missingNonEmptyAudioChunk:
    "No non-empty microphone audio chunk was recorded.",
  missingRightLensAudioChunk:
    "No non-empty microphone audio chunk was recorded from the right lens.",
  headsetInCradle: "The headset is still reporting cradle or charging state.",
  wearingStateNotObserved:
    "The headset never reported physical state 'wearing'.",
  reportStale:
    "The latest report is too old for a current hardware proof; rerun the hardware smoke.",
  reportNotMarkedOk:
    "The report did not satisfy the required hardware evidence checklist.",
  statusNotConnected:
    "The final service status did not report a connected headset.",
};

if ((import.meta as { main?: boolean }).main) {
  const args = process.argv.slice(2);
  const reportPath =
    args.find((arg) => !arg.startsWith("--")) ??
    process.env.SMARTGLASSES_REPORT_PATH;
  if (!reportPath) {
    console.error(
      "Usage: bun run validate-hardware-report.ts <smartglasses-hardware-report.json> [--max-age-ms <milliseconds>]",
    );
    process.exit(2);
  }
  const maxAgeMs = parseMaxAgeMs(args);

  const report = JSON.parse(
    await readFile(reportPath, "utf8"),
  ) as HardwareEvidenceReport;
  const summary = createHardwareValidationSummary(reportPath, report, {
    maxAgeMs,
  });

  if (!summary.ok) {
    console.error(JSON.stringify(summary, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify(summary, null, 2));
}

export function validateHardwareReport(
  report: HardwareEvidenceReport,
  options: { maxAgeMs?: number; now?: Date | string } = {},
): string[] {
  const failures = [
    ...missingCompleteHardwareEvidence(report, { requireFinishedAt: true }),
  ];
  if (
    options.maxAgeMs !== undefined &&
    isHardwareReportStale(report, options.maxAgeMs, options.now)
  ) {
    failures.push("reportStale");
  }
  if (!report.ok) failures.push("reportNotMarkedOk");
  return [...new Set(failures)];
}

export function createHardwareValidationSummary(
  reportPath: string,
  report: HardwareEvidenceReport,
  options: {
    maxAgeMs?: number;
    now?: Date | string;
    localBluetooth?: LocalBluetoothPreflight | null;
  } = {},
) {
  const failures = validateHardwareReport(report, options);
  const physicalBlocker = hardwarePhysicalBlocker(report);
  const scanDiagnosis =
    report.scanDiagnosis && report.scanDiagnosis !== "not_scanned"
      ? report.scanDiagnosis
      : hardwareScanDiagnosis(report);
  const localBluetooth =
    options.localBluetooth === undefined
      ? inspectLocalBluetoothPreflight()
      : options.localBluetooth;
  const pairedG1Devices =
    report.pairedG1Devices && report.pairedG1Devices.length > 0
      ? report.pairedG1Devices
      : (localBluetooth?.pairedG1Devices ?? []);
  const bluetoothAdapter =
    report.bluetoothAdapter ?? localBluetooth?.bluetoothAdapter ?? null;
  const bluetoothPreflightSource =
    report.pairedG1Devices?.length || report.bluetoothAdapter
      ? "report"
      : localBluetooth
        ? "local"
        : "none";
  const base = {
    ok: failures.length === 0,
    reportPath,
    checks: report.checks,
    discoveredDeviceCount: report.discoveredDevices?.length ?? 0,
    discoveredG1DeviceCount:
      report.discoveredDevices?.filter((device) => device.matchesG1).length ??
      0,
    pairedG1Devices,
    pairedG1DeviceCount: pairedG1Devices.length,
    pairedWholeHeadset: Boolean(
      pairedG1Devices.some((device) => device.side === "left") &&
        pairedG1Devices.some((device) => device.side === "right"),
    ),
    bluetoothAdapter,
    bluetoothPreflightSource,
    scanDiagnosis,
  };

  if (failures.length === 0) {
    return {
      ...base,
      initMode: report.initMode,
      writes: report.writes.length,
      events: report.events.length,
      audioChunks: report.audio.length,
      serial: report.status?.lastSerialNumber ?? null,
      headsetState: report.headsetState,
      audioEncoding: report.status?.lastAudioEncoding ?? null,
      audioSequenceGaps: report.status?.audioSequenceGaps ?? null,
    };
  }

  return {
    ...base,
    failures,
    failureDetails: failures.map((failure) => ({
      failure,
      description: describeValidationFailure(failure),
    })),
    lenses: report.lenses,
    discoveredDevices: report.discoveredDevices ?? [],
    status: report.status,
    reportAgeMs:
      options.maxAgeMs === undefined
        ? undefined
        : hardwareReportAgeMs(report, options.now),
    maxAgeMs: options.maxAgeMs,
    headsetState: report.headsetState,
    physicalBlocker,
    setupHint:
      setupHintForHardwareBlocker(physicalBlocker, report) ?? report.setupHint,
    nextAction: nextActionForHardwareBlocker(physicalBlocker),
  };
}

export function describeValidationFailure(failure: string): string {
  return VALIDATION_FAILURE_DESCRIPTIONS[failure] ?? failure;
}

export function hardwareReportAgeMs(
  report: HardwareEvidenceReport,
  now: Date | string = new Date(),
): number | null {
  const timestamp = new Date(report.finishedAt ?? report.startedAt).getTime();
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, new Date(now).getTime() - timestamp);
}

export function isHardwareReportStale(
  report: HardwareEvidenceReport,
  maxAgeMs: number,
  now: Date | string = new Date(),
): boolean {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) return true;
  const ageMs = hardwareReportAgeMs(report, now);
  return ageMs === null || ageMs > maxAgeMs;
}

function parseMaxAgeMs(args: string[]): number | undefined {
  const inline = args.find((arg) => arg.startsWith("--max-age-ms="));
  if (inline) return Number(inline.slice("--max-age-ms=".length));
  const index = args.indexOf("--max-age-ms");
  if (index >= 0) return Number(args[index + 1]);
  return undefined;
}
