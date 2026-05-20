import { readFile } from "node:fs/promises";
import {
  type HardwareEvidenceReport,
  headsetSetupHint,
  isCradleOrChargingState,
} from "./hardware-evidence.js";
import {
  describeValidationFailure,
  validateHardwareReport,
} from "./validate-hardware-report.js";

export type HardwareReportStatus = ReturnType<
  typeof createHardwareReportStatus
>;

export function createHardwareReportStatus(
  reportPath: string,
  report: HardwareEvidenceReport,
) {
  const failures = validateHardwareReport(report);
  const wholeHeadsetConnected = Boolean(
    report.status?.connected &&
      report.lenses.left.connected &&
      report.lenses.right.connected &&
      report.status.connectedLenses.left?.connected &&
      report.status.connectedLenses.right?.connected,
  );
  const wearingReady =
    wholeHeadsetConnected && report.headsetState.physical === "wearing";
  const physicalBlocker = !report.status?.connected
    ? "disconnected"
    : !wholeHeadsetConnected
      ? "partial_headset"
      : isCradleOrChargingState(
            report.headsetState.physical,
            report.headsetState.battery,
          )
        ? "in_charging_base"
        : wearingReady
          ? null
          : "wearing_state_missing";
  const setupHint = setupHintForBlocker(physicalBlocker, report);
  const nextAction = nextActionForBlocker(physicalBlocker);
  return {
    ok: failures.length === 0,
    reportPath,
    serial: report.status?.lastSerialNumber ?? null,
    lenses: report.lenses,
    headsetState: report.headsetState,
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

type HardwarePhysicalBlocker =
  | "disconnected"
  | "partial_headset"
  | "in_charging_base"
  | "wearing_state_missing"
  | null;

function setupHintForBlocker(
  physicalBlocker: HardwarePhysicalBlocker,
  report: HardwareEvidenceReport,
): string | null {
  if (physicalBlocker === "disconnected") {
    return "Connect both lenses as one headset before running hardware validation.";
  }
  if (physicalBlocker === "partial_headset") {
    return "Reconnect the whole headset so both left and right lenses are present.";
  }
  return report.setupHint ?? headsetSetupHint(report) ?? null;
}

function nextActionForBlocker(
  physicalBlocker: HardwarePhysicalBlocker,
): string | null {
  if (physicalBlocker === "disconnected") {
    return "Connect both lenses as one headset before running hardware validation.";
  }
  if (physicalBlocker === "partial_headset") {
    return "Reconnect the whole headset so both left and right lenses are present.";
  }
  if (physicalBlocker === "in_charging_base") {
    return "Remove both lenses from the charging base, wear the glasses, single tap, speak, then double tap.";
  }
  if (physicalBlocker === "wearing_state_missing") {
    return "Wear the glasses until they report wearing, then single tap, speak, and double tap.";
  }
  return null;
}

if ((import.meta as { main?: boolean }).main) {
  const reportPath =
    process.argv[2] ??
    process.env.SMARTGLASSES_REPORT_PATH ??
    "/tmp/smartglasses-hardware-report-latest.json";

  const report = JSON.parse(
    await readFile(reportPath, "utf8"),
  ) as HardwareEvidenceReport;

  console.log(
    JSON.stringify(createHardwareReportStatus(reportPath, report), null, 2),
  );
}
