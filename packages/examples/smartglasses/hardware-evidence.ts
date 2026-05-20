import type {
  G1ConnectionReadyMode,
  G1Event,
  GlassSide,
  SmartglassesAudioEncoding,
  SmartglassesStatus,
} from "../../../plugins/plugin-hearwear/src/index.js";

export type HardwareWriteSide = GlassSide | "both";

export type HardwarePhysicalBlocker =
  | "transport_unavailable"
  | "disconnected"
  | "headset_not_found"
  | "partial_headset"
  | "in_charging_base"
  | "wearing_state_missing"
  | null;

export type HardwareScanDiagnosis =
  | "not_scanned"
  | "no_ble_devices"
  | "ble_seen_no_g1_candidates"
  | "g1_candidates_seen"
  | "left_lens_missing"
  | "right_lens_missing"
  | "whole_headset_seen";

export type HardwareEvidenceReport = {
  ok: boolean;
  startedAt: string;
  finishedAt?: string;
  scanTimeoutMs?: number;
  holdMs?: number;
  initMode: G1ConnectionReadyMode;
  checks: Record<string, boolean>;
  discoveredDevices?: Array<{
    name: string | null;
    address?: string;
    rssi?: number | null;
    serviceUuids?: string[];
    manufacturerIds?: number[];
    matchesG1: boolean;
    matchReason?: "name" | "uart_service" | null;
  }>;
  pairedG1Devices?: Array<{
    name: string;
    side: GlassSide;
    connected: boolean;
    section?: string | null;
  }>;
  bluetoothAdapter?: {
    available?: boolean;
    state?: string | null;
    discoverable?: string | null;
    chipset?: string | null;
    address?: string | null;
  } | null;
  scanDiagnosis?: HardwareScanDiagnosis;
  evidenceOrder: number;
  writes: Array<{
    at: string;
    order?: number;
    side: HardwareWriteSide;
    command: string;
    bytes: number;
    hex: string;
  }>;
  events: Array<{
    at: string;
    order?: number;
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
    order?: number;
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
  "microphoneEnableWriteAfterTap",
  "microphoneDisabledByTap",
  "microphoneDisableWriteAfterTap",
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
      microphoneEnableWriteAfterTap: false,
      tapObserved: false,
      microphoneDisabledByTap: false,
      microphoneDisableWriteAfterTap: false,
      microphoneDisabledByCommand: false,
      audioObserved: false,
    },
    discoveredDevices: [],
    pairedG1Devices: [],
    bluetoothAdapter: null,
    scanDiagnosis: "not_scanned",
    evidenceOrder: 0,
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
    order: nextEvidenceOrder(report),
    side,
    command,
    bytes: data.length,
    hex: bytesToHex(data.slice(0, 24)),
  });
  if (command === "init" || command === "right-init")
    report.checks.connectionReadySent = true;
  if (command === "display-result") report.checks.displayPacketsSent = true;
  if (command === "get-serial") report.checks.serialRequested = true;
  if (command === "open-mic" && side === "right") {
    updateTapDrivenMicWriteChecks(report);
  }
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
    order: nextEvidenceOrder(report),
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
  updateTapDrivenMicWriteChecks(report);
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
    order: nextEvidenceOrder(report),
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
  if (!hasTapDrivenRightMicWrite(report, "enable"))
    failures.push("missingMicEnableWriteAfterTap");
  if (!hasTapDrivenRightMicWrite(report, "disable"))
    failures.push("missingMicDisableWriteAfterTap");
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
  const derivedScanDiagnosis = hardwareScanDiagnosis(report);
  if (
    !report.scanDiagnosis ||
    report.scanDiagnosis === "not_scanned" ||
    derivedScanDiagnosis === "whole_headset_seen" ||
    derivedScanDiagnosis === "left_lens_missing" ||
    derivedScanDiagnosis === "right_lens_missing"
  ) {
    report.scanDiagnosis = derivedScanDiagnosis;
  }
  report.setupHint = setupHintForHardwareBlocker(
    hardwarePhysicalBlocker(report),
    report,
  );
  updateTapDrivenMicWriteChecks(report);
  report.ok = missingCompleteHardwareEvidence(report).length === 0;
}

export function hardwarePhysicalBlocker(
  report: HardwareEvidenceReport,
): HardwarePhysicalBlocker {
  const wholeHeadsetConnected = Boolean(
    report.status?.connected &&
      report.lenses.left.connected &&
      report.lenses.right.connected &&
      report.status.connectedLenses?.left?.connected &&
      report.status.connectedLenses?.right?.connected,
  );
  const anyLensConnected = Boolean(
    report.lenses.left.connected ||
      report.lenses.right.connected ||
      report.status?.connectedLenses?.left?.connected ||
      report.status?.connectedLenses?.right?.connected,
  );
  if (report.status && !report.status.available) return "transport_unavailable";
  if (report.status?.available && !anyLensConnected) return "headset_not_found";
  if (!report.status?.connected) return "disconnected";
  if (!wholeHeadsetConnected) return "partial_headset";
  if (
    isCradleOrChargingState(
      report.headsetState.physical,
      report.headsetState.battery,
    )
  ) {
    return "in_charging_base";
  }
  return report.headsetState.physical === "wearing"
    ? null
    : "wearing_state_missing";
}

export function hardwareScanDiagnosis(
  report: HardwareEvidenceReport,
): HardwareScanDiagnosis {
  if (report.lenses.left.connected && report.lenses.right.connected) {
    return "whole_headset_seen";
  }
  if (report.lenses.left.connected) return "right_lens_missing";
  if (report.lenses.right.connected) return "left_lens_missing";
  const discovered = report.discoveredDevices ?? [];
  if (discovered.length === 0)
    return report.finishedAt ? "no_ble_devices" : "not_scanned";
  if (discovered.some((device) => device.matchesG1))
    return "g1_candidates_seen";
  return report.finishedAt ? "ble_seen_no_g1_candidates" : "not_scanned";
}

export function setupHintForHardwareBlocker(
  physicalBlocker: HardwarePhysicalBlocker,
  report: Pick<HardwareEvidenceReport, "headsetState">,
): string | undefined {
  if (physicalBlocker === "transport_unavailable") {
    return "The hardware transport is unavailable before headset discovery. Use the Bleak/CoreBluetooth smoke on macOS, or install/rebuild the Noble native BLE binding for this runtime.";
  }
  if (physicalBlocker === "disconnected") {
    return "Connect both lenses as one headset before running hardware validation.";
  }
  if (physicalBlocker === "headset_not_found") {
    return "No G1 lenses were found. Remove both lenses from the charging base, keep them near this device, and rerun hardware pairing.";
  }
  if (physicalBlocker === "partial_headset") {
    return "Reconnect the whole headset so both left and right lenses are present.";
  }
  if (physicalBlocker === null) return undefined;
  return headsetSetupHint(report);
}

export function nextActionForHardwareBlocker(
  physicalBlocker: HardwarePhysicalBlocker,
): string | null {
  if (physicalBlocker === "transport_unavailable") {
    return "From the repo root, run npm run smartglasses:hardware:prove for macOS CoreBluetooth proof, or rebuild @abandonware/noble before using npm run smartglasses:hardware:prove:noble.";
  }
  if (physicalBlocker === "disconnected") {
    return "Connect both lenses as one headset before running hardware validation.";
  }
  if (physicalBlocker === "headset_not_found") {
    return "Remove both lenses from the charging base, keep them near this device, and run npm run smartglasses:hardware:prove:watch from the repo root.";
  }
  if (physicalBlocker === "partial_headset") {
    return "Reconnect the whole headset so both left and right lenses are present.";
  }
  if (physicalBlocker === "in_charging_base") {
    return "Remove both lenses from the charging base, wear the glasses, single tap, speak, then double tap.";
  }
  if (physicalBlocker === "wearing_state_missing") {
    return "Wear the glasses until they report wearing, or run npm run smartglasses:hardware:prove:watch from the repo root for a longer latest-report proof window; then single tap, speak, and double tap.";
  }
  return null;
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

function hasTapDrivenRightMicWrite(
  report: HardwareEvidenceReport,
  mode: "enable" | "disable",
): boolean {
  const labels =
    mode === "enable"
      ? ["single_tap", "long_press"]
      : ["double_tap", "stop_ai_recording"];
  const micValue = mode === "enable" ? "01" : "00";
  const tapEvents = report.events.filter((event) =>
    labels.includes(event.label ?? ""),
  );
  const micWrites = report.writes.filter(
    (write) =>
      write.side === "right" &&
      write.command === "open-mic" &&
      write.hex.startsWith(`0e${micValue}`),
  );
  return tapEvents.some((event) =>
    micWrites.some((write) => evidenceHappenedAfter(write, event)),
  );
}

function updateTapDrivenMicWriteChecks(report: HardwareEvidenceReport): void {
  report.checks.microphoneEnableWriteAfterTap = hasTapDrivenRightMicWrite(
    report,
    "enable",
  );
  report.checks.microphoneDisableWriteAfterTap = hasTapDrivenRightMicWrite(
    report,
    "disable",
  );
}

function evidenceHappenedAfter(
  later: { at: string; order?: number },
  earlier: { at: string; order?: number },
): boolean {
  if (
    Number.isFinite(later.order) &&
    Number.isFinite(earlier.order) &&
    later.order !== undefined &&
    earlier.order !== undefined
  ) {
    return later.order > earlier.order;
  }
  const laterMs = Date.parse(later.at);
  const earlierMs = Date.parse(earlier.at);
  return Number.isFinite(laterMs) && Number.isFinite(earlierMs)
    ? laterMs >= earlierMs
    : false;
}

function nextEvidenceOrder(report: HardwareEvidenceReport): number {
  report.evidenceOrder = (report.evidenceOrder ?? 0) + 1;
  return report.evidenceOrder;
}
