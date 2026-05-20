import { readFile } from "node:fs/promises";
import {
  type HardwareEvidenceReport,
  missingCompleteHardwareEvidence,
} from "./hardware-evidence.js";

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
  microphoneDisabledByTap:
    "A double tap or stop-recording event must disable microphone input.",
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
  missingNonEmptyAudioChunk:
    "No non-empty microphone audio chunk was recorded.",
  missingRightLensAudioChunk:
    "No non-empty microphone audio chunk was recorded from the right lens.",
  headsetInCradle: "The headset is still reporting cradle or charging state.",
  wearingStateNotObserved:
    "The headset never reported physical state 'wearing'.",
  reportNotMarkedOk:
    "The report did not satisfy the required hardware evidence checklist.",
  statusNotConnected:
    "The final service status did not report a connected headset.",
};

if ((import.meta as { main?: boolean }).main) {
  const reportPath = process.argv[2] ?? process.env.SMARTGLASSES_REPORT_PATH;
  if (!reportPath) {
    console.error(
      "Usage: bun run validate-hardware-report.ts <smartglasses-hardware-report.json>",
    );
    process.exit(2);
  }

  const report = JSON.parse(
    await readFile(reportPath, "utf8"),
  ) as HardwareEvidenceReport;
  const failures = validateHardwareReport(report);

  if (failures.length > 0) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          reportPath,
          failures,
          failureDetails: failures.map((failure) => ({
            failure,
            description: describeValidationFailure(failure),
          })),
          checks: report.checks,
          lenses: report.lenses,
          status: report.status,
          headsetState: report.headsetState,
          setupHint: report.setupHint,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        reportPath,
        initMode: report.initMode,
        checks: report.checks,
        writes: report.writes.length,
        events: report.events.length,
        audioChunks: report.audio.length,
        serial: report.status?.lastSerialNumber ?? null,
        headsetState: report.headsetState,
        audioEncoding: report.status?.lastAudioEncoding ?? null,
        audioSequenceGaps: report.status?.audioSequenceGaps ?? null,
      },
      null,
      2,
    ),
  );
}

export function validateHardwareReport(
  report: HardwareEvidenceReport,
): string[] {
  const failures = [
    ...missingCompleteHardwareEvidence(report, { requireFinishedAt: true }),
  ];
  if (!report.ok) failures.push("reportNotMarkedOk");
  return [...new Set(failures)];
}

export function describeValidationFailure(failure: string): string {
  return VALIDATION_FAILURE_DESCRIPTIONS[failure] ?? failure;
}
