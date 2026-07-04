import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  type HardwareEvidenceReport,
  hardwarePhysicalBlocker,
  hardwareScanDiagnosis,
  nextActionForHardwareBlocker,
  setupHintForHardwareBlocker,
} from "./hardware-evidence.js";
import {
  inspectLocalBluetoothPreflight,
  type LocalBluetoothPreflight,
} from "./hardware-local-bluetooth.js";
import {
  describeValidationFailure,
  hardwareReportAgeMs,
  validateHardwareReport,
} from "./validate-hardware-report.js";

export type HardwareReportStatus = ReturnType<
  typeof createHardwareReportStatus
>;

export function createMissingHardwareReportStatus(
  reportPath: string,
  options: {
    localBluetooth?: LocalBluetoothPreflight | null;
    staleAfterMs?: number;
  } = {},
) {
  const staleAfterMs = options.staleAfterMs ?? 10 * 60 * 1000;
  const localBluetooth =
    options.localBluetooth === undefined
      ? inspectLocalBluetoothPreflight()
      : options.localBluetooth;
  const pairedG1Devices = localBluetooth?.pairedG1Devices ?? [];
  const pairedWholeHeadset = Boolean(
    pairedG1Devices.some((device) => device.side === "left") &&
      pairedG1Devices.some((device) => device.side === "right"),
  );
  const pairedConnectedWholeHeadset = Boolean(
    pairedG1Devices.some(
      (device) => device.side === "left" && device.connected,
    ) &&
      pairedG1Devices.some(
        (device) => device.side === "right" && device.connected,
      ),
  );

  return {
    ok: false,
    reportPath,
    startedAt: null,
    finishedAt: null,
    reportAgeSeconds: null,
    reportStale: true,
    staleAfterSeconds: Math.round(staleAfterMs / 1000),
    serial: null,
    lenses: null,
    headsetState: null,
    discoveredDevices: [],
    discoveredDeviceCount: 0,
    discoveredG1DeviceCount: 0,
    pairedG1Devices,
    pairedG1DeviceCount: pairedG1Devices.length,
    pairedWholeHeadset,
    bluetoothAdapter: localBluetooth?.bluetoothAdapter ?? null,
    bluetoothPreflightSource: localBluetooth ? "local" : "none",
    scanDiagnosis: "not_scanned",
    wholeHeadsetConnected: pairedConnectedWholeHeadset,
    wearingReady: false,
    physicalBlocker: pairedConnectedWholeHeadset
      ? "wearing_state_missing"
      : pairedWholeHeadset
        ? "headset_not_found"
        : "missing_report",
    setupHint: pairedWholeHeadset
      ? "Both G1 lenses are paired locally, but no latest proof report exists yet."
      : "No latest proof report exists yet. Pair both G1 lenses or use a native mobile bridge before running hardware proof.",
    nextAction: pairedWholeHeadset
      ? "Remove both lenses from the charging base, wear them near this device, then run `bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch` from the repo root."
      : "Pair both G1 lenses, then run `bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch` from the repo root.",
    checks: null,
    audioChunks: 0,
    statusAudioChunks: 0,
    failures: ["missingReport"],
    failureDetails: [
      {
        failure: "missingReport",
        description:
          "No latest hardware report exists yet; run the hardware proof command to create one.",
      },
    ],
  };
}

export function createHardwareReportStatus(
  reportPath: string,
  report: HardwareEvidenceReport,
  options: {
    now?: Date | string;
    staleAfterMs?: number;
    localBluetooth?: LocalBluetoothPreflight | null;
  } = {},
) {
  const staleAfterMs = options.staleAfterMs ?? 10 * 60 * 1000;
  const now = options.now ?? new Date();
  const failures = validateHardwareReport(report, {
    maxAgeMs: staleAfterMs,
    now,
  });
  const reportAgeMs = hardwareReportAgeMs(report, now);
  const wholeHeadsetConnected = Boolean(
    report.status?.connected &&
      report.lenses.left.connected &&
      report.lenses.right.connected &&
      report.status.connectedLenses.left?.connected &&
      report.status.connectedLenses.right?.connected,
  );
  const wearingReady =
    wholeHeadsetConnected && report.headsetState.physical === "wearing";
  const physicalBlocker = hardwarePhysicalBlocker(report);
  const setupHint =
    setupHintForHardwareBlocker(physicalBlocker, report) ?? null;
  const nextAction = nextActionForHardwareBlocker(physicalBlocker);
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
  return {
    ok: failures.length === 0,
    reportPath,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt ?? null,
    reportAgeSeconds:
      reportAgeMs === null ? null : Math.round(reportAgeMs / 1000),
    reportStale: failures.includes("reportStale"),
    staleAfterSeconds: Math.round(staleAfterMs / 1000),
    serial: report.status?.lastSerialNumber ?? null,
    lenses: report.lenses,
    headsetState: report.headsetState,
    discoveredDevices: report.discoveredDevices ?? [],
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
    wholeHeadsetConnected,
    wearingReady,
    physicalBlocker,
    setupHint,
    nextAction,
    checks: report.checks,
    audioChunks: report.audio.length,
    statusAudioChunks: report.status?.audioChunksReceived ?? 0,
    failures,
    failureDetails: failures.map((failure) => ({
      failure,
      description: describeValidationFailure(failure),
    })),
  };
}

if ((import.meta as { main?: boolean }).main) {
  const reportPath =
    process.argv[2] ??
    process.env.SMARTGLASSES_REPORT_PATH ??
    "/tmp/smartglasses-hardware-report-latest.json";

  if (!existsSync(reportPath)) {
    console.log(
      JSON.stringify(createMissingHardwareReportStatus(reportPath), null, 2),
    );
    process.exit(0);
  }

  const report = JSON.parse(
    await readFile(reportPath, "utf8"),
  ) as HardwareEvidenceReport;

  console.log(
    JSON.stringify(createHardwareReportStatus(reportPath, report), null, 2),
  );
}
