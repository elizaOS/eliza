import type {
  G1ConnectionReadyMode,
  G1Event,
  GlassSide,
  SmartglassesAudioEncoding,
} from "../../../plugins/plugin-smartglasses/src/protocol.js";
import type { SmartglassesStatus } from "../../../plugins/plugin-smartglasses/src/services/smartglasses-service.js";

export type HardwareWriteSide = GlassSide | "both";

export type HardwareEvidenceReport = {
  ok: boolean;
  startedAt: string;
  finishedAt?: string;
  scanTimeoutMs?: number;
  holdMs?: number;
  initMode: G1ConnectionReadyMode;
  checks: Record<string, boolean>;
  writes: Array<{
    at: string;
    side: HardwareWriteSide;
    command: string;
    bytes: number;
    hex: string;
  }>;
  events: Array<{
    at: string;
    side: string;
    type: string;
    label?: string;
    stateCategory?: string;
    stateName?: string;
    sequence?: number;
    serialNumber?: string;
  }>;
  lenses: Record<
    GlassSide,
    {
      connected: boolean;
      name?: string;
      address?: string;
    }
  >;
  audio: Array<{
    at: string;
    side: string;
    sampleRate: number;
    encoding: string | null;
    sequence?: number;
    bytes: number;
  }>;
  status?: SmartglassesStatus;
  headsetState: {
    physical: string | null;
    battery: string | null;
    device: string | null;
  };
  setupHint?: string;
  error?: string;
};

export const REQUIRED_HARDWARE_EVIDENCE = [
  "connected",
  "connectionReadySent",
  "displayPacketsSent",
  "serialRequested",
  "serialObserved",
  "settingsSent",
  "tapObserved",
  "microphoneEnabledByTap",
  "microphoneDisabledByTap",
  "audioObserved",
] as const;

export function createHardwareEvidenceReport(options: {
  initMode: G1ConnectionReadyMode;
  scanTimeoutMs?: number;
  holdMs?: number;
}): HardwareEvidenceReport {
  return {
    ok: false,
    startedAt: new Date().toISOString(),
    scanTimeoutMs: options.scanTimeoutMs,
    holdMs: options.holdMs,
    initMode: options.initMode,
    checks: {
      connected: false,
      connectionReadySent: false,
      displayPacketsSent: false,
      serialRequested: false,
      serialObserved: false,
      settingsSent: false,
      microphoneEnabled: false,
      microphoneEnabledByTap: false,
      tapObserved: false,
      microphoneDisabledByTap: false,
      microphoneDisabledByCommand: false,
      audioObserved: false,
    },
    writes: [],
    events: [],
    lenses: {
      left: { connected: false },
      right: { connected: false },
    },
    audio: [],
    headsetState: {
      physical: null,
      battery: null,
      device: null,
    },
  };
}

export function recordHardwareLens(
  report: HardwareEvidenceReport,
  side: GlassSide,
  lens: {
    connected?: boolean;
    name?: string;
    address?: string;
  },
): void {
  report.lenses[side] = {
    connected: lens.connected ?? true,
    name: lens.name,
    address: lens.address,
  };
}

export function recordHardwareWrite(
  report: HardwareEvidenceReport,
  side: HardwareWriteSide,
  data: Uint8Array,
): void {
  const command = hardwareCommandName(data);
  report.writes.push({
    at: new Date().toISOString(),
    side,
    command,
    bytes: data.length,
    hex: bytesToHex(data.slice(0, 24)),
  });
  if (command === "init" || command === "right-init")
    report.checks.connectionReadySent = true;
  if (command === "display-result") report.checks.displayPacketsSent = true;
  if (command === "get-serial") report.checks.serialRequested = true;
  if (
    command === "brightness" ||
    command === "dashboard" ||
    command === "head-up-angle" ||
    command === "wear-detection"
  ) {
    report.checks.settingsSent = true;
  }
}

export function recordHardwareEvent(
  report: HardwareEvidenceReport,
  event: G1Event,
): void {
  if (event.stateCategory === "physical") {
    report.headsetState.physical = event.stateName ?? event.label ?? null;
  } else if (event.stateCategory === "battery") {
    report.headsetState.battery = event.stateName ?? event.label ?? null;
  } else if (event.stateCategory === "device") {
    report.headsetState.device = event.stateName ?? event.label ?? null;
  }
  report.events.push({
    at: new Date().toISOString(),
    side: event.side,
    type: event.type,
    label: event.label,
    stateCategory: event.stateCategory,
    stateName: event.stateName,
    sequence: event.sequence,
    serialNumber: event.serialNumber,
  });
  if (event.label?.includes("tap") || event.label === "long_press")
    report.checks.tapObserved = true;
  if (event.label === "single_tap" || event.label === "long_press") {
    report.checks.microphoneEnabled = true;
    report.checks.microphoneEnabledByTap = true;
  }
  if (event.label === "double_tap" || event.label === "stop_ai_recording")
    report.checks.microphoneDisabledByTap = true;
  if (event.type === "serial" && event.serialNumber)
    report.checks.serialObserved = true;
}

export function recordHardwareAudio(
  report: HardwareEvidenceReport,
  audio: Uint8Array,
  sampleRate: number,
  side: GlassSide,
  encoding: SmartglassesAudioEncoding | undefined,
  sequence?: number,
): void {
  report.checks.audioObserved = true;
  report.audio.push({
    at: new Date().toISOString(),
    side,
    sampleRate,
    encoding: encoding ?? null,
    sequence,
    bytes: audio.length,
  });
}

export function markHardwareMicrophoneCommand(
  report: HardwareEvidenceReport,
  enabled: boolean,
): void {
  report.checks[enabled ? "microphoneEnabled" : "microphoneDisabledByCommand"] =
    true;
}

export function missingHardwareEvidence(
  report: HardwareEvidenceReport,
): string[] {
  return REQUIRED_HARDWARE_EVIDENCE.filter((check) => !report.checks[check]);
}

export type CompleteHardwareEvidenceOptions = {
  requireFinishedAt?: boolean;
};

export function missingCompleteHardwareEvidence(
  report: HardwareEvidenceReport,
  options: CompleteHardwareEvidenceOptions = {},
): string[] {
  const failures = [...missingHardwareEvidence(report)];
  if (options.requireFinishedAt && !report.finishedAt)
    failures.push("missingFinishedAt");
  if (!report.status?.connected) failures.push("statusNotConnected");
  if (!report.lenses.left.connected) failures.push("missingLeftLensConnection");
  if (!report.lenses.right.connected)
    failures.push("missingRightLensConnection");
  if (!report.status?.connectedLenses?.left?.connected)
    failures.push("missingStatusLeftLensConnection");
  if (!report.status?.connectedLenses?.right?.connected)
    failures.push("missingStatusRightLensConnection");
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
  if (!hasRightMicWrite(report, "enable"))
    failures.push("missingMicEnableWrite");
  if (!hasRightMicWrite(report, "disable"))
    failures.push("missingMicDisableWrite");
  if (!report.audio.some((chunk) => chunk.bytes > 0))
    failures.push("missingNonEmptyAudioChunk");
  if (!report.audio.some((chunk) => chunk.side === "right" && chunk.bytes > 0))
    failures.push("missingRightLensAudioChunk");
  if (
    report.headsetState.physical !== "wearing" &&
    isCradleOrChargingState(
      report.headsetState.physical,
      report.headsetState.battery,
    )
  ) {
    failures.push("headsetInCradle");
  }
  if (report.headsetState.physical !== "wearing")
    failures.push("wearingStateNotObserved");
  return [...new Set(failures)];
}

export function updateHardwareEvidenceStatus(
  report: HardwareEvidenceReport,
  status: SmartglassesStatus,
): void {
  report.status = status;
  if (status.physicalState !== null) {
    report.headsetState.physical = status.physicalState;
  }
  if (status.batteryState !== null) {
    report.headsetState.battery = status.batteryState;
  }
  if (status.deviceState !== null) {
    report.headsetState.device = status.deviceState;
  }
  if (status.connectedLenses?.left) {
    recordHardwareLens(report, "left", status.connectedLenses.left);
  }
  if (status.connectedLenses?.right) {
    recordHardwareLens(report, "right", status.connectedLenses.right);
  }
  report.setupHint = headsetSetupHint(report);
  report.ok = missingCompleteHardwareEvidence(report).length === 0;
}

export function headsetSetupHint(
  report: Pick<HardwareEvidenceReport, "headsetState">,
): string | undefined {
  const { physical, battery } = report.headsetState;
  if (physical === "wearing") return undefined;
  const stateText =
    [physical, battery].filter(Boolean).join(" / ") ||
    "no wearing state observed";
  if (isCradleOrChargingState(physical, battery)) {
    return `Glasses are reporting ${stateText}; remove them from the charging base and wear them before tap or microphone validation.`;
  }
  return `Tap and microphone validation requires the glasses to report wearing; current state is ${stateText}.`;
}

export function isCradleOrChargingState(
  physical: string | null,
  battery: string | null,
): boolean {
  return (
    physical === "cradle_open" ||
    physical === "cradle_closed" ||
    physical === "charged_in_cradle" ||
    battery === "glasses_fully_charged" ||
    battery === "cradle_charging_cable_changed" ||
    battery === "cradle_fully_charged"
  );
}

export function hardwareCommandName(data: Uint8Array): string {
  const command = data[0];
  switch (command) {
    case 0x4d:
      return "init";
    case 0xf4:
      return "right-init";
    case 0x4e:
      return "display-result";
    case 0x0e:
      return "open-mic";
    case 0x34:
      return "get-serial";
    case 0x01:
      return "brightness";
    case 0x22:
      return "dashboard";
    case 0x0b:
      return "head-up-angle";
    case 0x27:
      return "wear-detection";
    default:
      return `0x${command.toString(16).padStart(2, "0")}`;
  }
}

function bytesToHex(data: Uint8Array): string {
  return [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasRightMicWrite(
  report: HardwareEvidenceReport,
  mode: "enable" | "disable",
): boolean {
  const suffix = mode === "enable" ? "01" : "00";
  return report.writes.some(
    (write) =>
      write.side === "right" &&
      write.command === "open-mic" &&
      write.hex.startsWith(`0e${suffix}`),
  );
}
