import {
  type HardwareEvidenceReport,
  missingHardwareEvidence,
} from "./hardware-evidence.js";
import { readFile } from "node:fs/promises";

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
          checks: report.checks,
          status: report.status,
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
  const failures = [...missingHardwareEvidence(report)];
  if (!report.ok) failures.push("reportNotMarkedOk");
  if (!report.finishedAt) failures.push("missingFinishedAt");
  if (!report.status?.connected) failures.push("statusNotConnected");
  if (!report.status?.lastSerialNumber) failures.push("missingSerialNumber");
  if ((report.status?.audioChunksReceived ?? 0) < 1)
    failures.push("missingStatusAudioChunks");
  if (report.writes.length === 0) failures.push("missingWrites");
  if (report.events.length === 0) failures.push("missingEvents");
  if (report.audio.length === 0) failures.push("missingAudioChunks");
  if (
    !report.writes.some(
      (write) => write.command === "init" || write.command === "right-init",
    )
  )
    failures.push("missingInitWrite");
  if (!report.writes.some((write) => write.command === "display-result"))
    failures.push("missingDisplayWrite");
  if (!report.writes.some((write) => write.command === "get-serial"))
    failures.push("missingSerialRequestWrite");
  if (
    !report.writes.some((write) =>
      ["brightness", "dashboard", "head-up-angle", "wear-detection"].includes(
        write.command,
      ),
    )
  )
    failures.push("missingSettingsWrite");
  if (!report.events.some((event) => event.type === "serial"))
    failures.push("missingSerialEvent");
  if (
    !report.events.some(
      (event) => event.label === "single_tap" || event.label === "long_press",
    )
  )
    failures.push("missingMicEnableTapEvent");
  if (
    !report.events.some(
      (event) =>
        event.label === "double_tap" || event.label === "stop_ai_recording",
    )
  )
    failures.push("missingMicDisableTapEvent");
  if (!report.audio.some((chunk) => chunk.bytes > 0))
    failures.push("missingNonEmptyAudioChunk");
  if (!report.audio.some((chunk) => chunk.side === "right" && chunk.bytes > 0))
    failures.push("missingRightLensAudioChunk");
  return [...new Set(failures)];
}
