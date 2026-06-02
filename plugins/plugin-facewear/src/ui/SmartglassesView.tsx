import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  BatteryCharging,
  Bluetooth,
  CheckCircle2,
  Clipboard,
  Download,
  Glasses,
  Mic,
  RefreshCw,
  Settings2,
  Wifi,
  XCircle,
} from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import {
  type DisplayPage,
  encodeBatteryStatusRequest,
  encodeBrightness,
  encodeClearScreen,
  encodeConnectionReady,
  encodeGetSerial,
  encodeSilentMode,
  encodeTextPackets,
  G1AiStatus,
  type G1Event,
  G1ScreenAction,
  G1TextStatus,
  type GlassSide,
  paginateDisplayText,
  type SmartglassesAudioEncoding,
} from "../protocol/smartglasses.ts";
import { EvenBridgeTransport } from "../transport/even-bridge.ts";
import type { SmartglassesTransport } from "../transport/types.ts";
import {
  getWebBluetoothG1Transport,
  WebBluetoothG1Transport,
} from "../transport/web-bluetooth.ts";

export type LensState = "idle" | "prompting" | "connected" | "failed";
type PlatformKey = "desktop" | "ios" | "android";
export type ViewScanDiagnosis =
  | "not_scanned"
  | "left_lens_missing"
  | "right_lens_missing"
  | "whole_headset_seen"
  | "pairing_failed";
export type ViewPhysicalBlocker =
  | "not_connected"
  | "partial_headset"
  | "in_charging_base"
  | "wearing_state_missing"
  | "evidence_missing"
  | null;

interface ReportEvent {
  at: string;
  type: string;
  detail: string;
}

interface ReportWrite {
  at: string;
  side: GlassSide | "both";
  command: string;
  bytes: number;
  hex: string;
}

interface ReportAudio {
  at: string;
  side: GlassSide;
  sampleRate: number;
  encoding: SmartglassesAudioEncoding | null;
  sequence?: number;
  bytes: number;
}

interface HardwareReport {
  ok: boolean;
  generatedAt: string;
  transport: string | null;
  connected: boolean;
  lenses: Record<GlassSide, LensState>;
  scanDiagnosis: ViewScanDiagnosis;
  physicalBlocker: ViewPhysicalBlocker;
  setupHint: string | null;
  nextAction: string | null;
  serialNumber: string | null;
  tests: Record<string, boolean>;
  missingEvidence: string[];
  events: ReportEvent[];
  writes: ReportWrite[];
  audio: ReportAudio[];
  wifi: {
    available: boolean;
    status: string;
    networks: string[];
  };
  headsetState: {
    physical: string | null;
    battery: string | null;
    batteryLevels: Partial<Record<GlassSide, number>>;
    device: string | null;
  };
}

type BridgeResult = unknown;
type BridgeSubscription =
  | undefined
  | (() => void)
  | { unsubscribe?: () => void; off?: () => void; remove?: () => void };

type SmartglassesBridge = {
  requestWifiScan?: () => Promise<BridgeResult> | BridgeResult;
  requestWifiStatus?: () => Promise<BridgeResult> | BridgeResult;
  requestWifiSetup?: (reason?: string) => Promise<BridgeResult> | BridgeResult;
  setWifiCredentials?: (
    ssid: string,
    password: string,
  ) => Promise<BridgeResult> | BridgeResult;
  sendWifiCredentials?: (
    ssid: string,
    password: string,
  ) => Promise<BridgeResult> | BridgeResult;
  audioControl?: (enabled: boolean) => Promise<BridgeResult> | BridgeResult;
  clearDisplay?: () => Promise<BridgeResult> | BridgeResult;
  createStartUpPageContainer?: (
    container: Record<string, unknown>,
  ) => Promise<BridgeResult> | BridgeResult;
  displayText?: (
    params: Record<string, unknown>,
  ) => Promise<BridgeResult> | BridgeResult;
  onEvent?: (callback: (event: unknown) => void) => BridgeSubscription;
  onEvenHubEvent?: (callback: (event: unknown) => void) => BridgeSubscription;
  rebuildPageContainer?: (
    container: Record<string, unknown>,
  ) => Promise<BridgeResult> | BridgeResult;
  sendStartUpPage?: (
    container: unknown,
  ) => Promise<BridgeResult> | BridgeResult;
  setMicState?: (
    sendPcmData: boolean,
    sendTranscript: boolean,
    bypassVad: boolean,
  ) => Promise<BridgeResult> | BridgeResult;
  write?: (
    side: GlassSide,
    data: Uint8Array,
  ) => Promise<BridgeResult> | BridgeResult;
  send?: (
    side: GlassSide,
    data: Uint8Array,
  ) => Promise<BridgeResult> | BridgeResult;
  rawBridge?: {
    audioControl?: (enabled: boolean) => Promise<BridgeResult> | BridgeResult;
    callEvenApp?: (
      name: string,
      payload?: Record<string, unknown>,
    ) => Promise<BridgeResult> | BridgeResult;
  };
};

declare global {
  interface Window {
    __evenBridge?: SmartglassesBridge;
    __mentraBridge?: SmartglassesBridge;
    facewearSmartglassesReport?: HardwareReport;
  }
}

const PLATFORM_COPY: Record<
  PlatformKey,
  { label: string; primary: string; secondary: string }
> = {
  desktop: {
    label: "Desktop",
    primary: "Chrome/Edge Web Bluetooth",
    secondary: "Pair both lenses; disconnect stale phone pairings if needed.",
  },
  ios: {
    label: "iOS",
    primary: "Native bridge required",
    secondary: "Safari has no direct Web Bluetooth pairing path.",
  },
  android: {
    label: "Android",
    primary: "Native bridge preferred",
    secondary: "Use the host for pairing, Wi-Fi scan, and credentials.",
  },
};

function now(): string {
  return new Date().toISOString();
}

function timeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(id);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(id);
        reject(err);
      },
    );
  });
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getBridge(): SmartglassesBridge | null {
  if (typeof window === "undefined") return null;
  return window.__mentraBridge ?? window.__evenBridge ?? null;
}

function isMicEnableTap(label?: string | null): boolean {
  return label === "single_tap" || label === "long_press";
}

function isMicDisableTap(label?: string | null): boolean {
  return label === "double_tap" || label === "stop_ai_recording";
}

function reportTimeMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function reportHappenedAfter(
  later: { at: string },
  earlier: { at: string },
): boolean {
  const laterMs = reportTimeMs(later.at);
  const earlierMs = reportTimeMs(earlier.at);
  return laterMs !== null && earlierMs !== null ? laterMs >= earlierMs : false;
}

function hasTapDrivenViewMicWrite(
  events: ReportEvent[],
  writes: ReportWrite[],
  mode: "enable" | "disable",
): boolean {
  const isTap = mode === "enable" ? isMicEnableTap : isMicDisableTap;
  const expectedHex = mode === "enable" ? "0e01" : "0e00";
  const tapEvents = events.filter((event) => isTap(event.detail));
  const micWrites = writes.filter(
    (write) =>
      write.side === "right" &&
      write.command === "open-mic" &&
      write.hex.startsWith(expectedHex),
  );
  return tapEvents.some((event) =>
    micWrites.some((write) => reportHappenedAfter(write, event)),
  );
}

function isCradleOrChargingState(
  physicalState: string | null,
  batteryState: string | null,
): boolean {
  return (
    physicalState === "cradle_open" ||
    physicalState === "cradle_closed" ||
    physicalState === "charged_in_cradle" ||
    batteryState === "glasses_fully_charged" ||
    batteryState === "cradle_charging_cable_changed" ||
    batteryState === "cradle_fully_charged"
  );
}

function headsetValidationBlocker(
  physicalState: string | null,
  batteryState: string | null,
): string | null {
  if (physicalState === "wearing") return null;
  const stateText =
    [physicalState, batteryState].filter(Boolean).join(" / ") ||
    "no wearing state observed";
  if (isCradleOrChargingState(physicalState, batteryState)) {
    return `Glasses are still reporting ${stateText}. Remove them from the charging base and wear them before tap or microphone validation.`;
  }
  return `Tap and microphone validation requires a wearing state; current state is ${stateText}.`;
}

export function missingViewEvidence(
  tests: Record<string, boolean>,
  lenses: Record<GlassSide, LensState>,
  physicalState: string | null,
  batteryState: string | null,
  events: ReportEvent[] = [],
  writes: ReportWrite[] = [],
): string[] {
  const hasTapDrivenEnableWrite = hasTapDrivenViewMicWrite(
    events,
    writes,
    "enable",
  );
  const hasTapDrivenDisableWrite = hasTapDrivenViewMicWrite(
    events,
    writes,
    "disable",
  );
  const missing = [
    lenses.left !== "connected" && "leftLensConnected",
    lenses.right !== "connected" && "rightLensConnected",
    physicalState !== "wearing" && "wearingStateObserved",
    isCradleOrChargingState(physicalState, batteryState) && "headsetInCradle",
    !tests.init && "connectionReadySent",
    !tests.display && "displayPacketsSent",
    !tests.serial && "serialRequested",
    !tests.serialObserved && "serialObserved",
    !tests.settings && "settingsSent",
    !hasTapDrivenEnableWrite && "rightMicEnableWrite",
    !hasTapDrivenDisableWrite && "rightMicDisableWrite",
    !tests.tapMicEnable && "tapMicEnable",
    !tests.tapMicDisable && "tapMicDisable",
    !tests.audio && "rightOrBridgeAudio",
  ].filter((value): value is string => typeof value === "string");
  return [...new Set(missing)];
}

export function viewScanDiagnosis(
  lenses: Record<GlassSide, LensState>,
): ViewScanDiagnosis {
  if (lenses.left === "connected" && lenses.right === "connected") {
    return "whole_headset_seen";
  }
  if (lenses.left === "failed" || lenses.right === "failed") {
    return "pairing_failed";
  }
  if (lenses.left === "connected") return "right_lens_missing";
  if (lenses.right === "connected") return "left_lens_missing";
  return "not_scanned";
}

export function viewPhysicalBlocker(
  tests: Record<string, boolean>,
  lenses: Record<GlassSide, LensState>,
  physicalState: string | null,
  batteryState: string | null,
  events: ReportEvent[] = [],
  writes: ReportWrite[] = [],
): ViewPhysicalBlocker {
  const wholeHeadset =
    lenses.left === "connected" && lenses.right === "connected";
  if (
    !wholeHeadset &&
    (lenses.left === "connected" || lenses.right === "connected")
  ) {
    return "partial_headset";
  }
  if (!wholeHeadset) return "not_connected";
  if (isCradleOrChargingState(physicalState, batteryState)) {
    return "in_charging_base";
  }
  if (physicalState !== "wearing") return "wearing_state_missing";
  return missingViewEvidence(
    tests,
    lenses,
    physicalState,
    batteryState,
    events,
    writes,
  ).length
    ? "evidence_missing"
    : null;
}

export function viewSetupHint(
  blocker: ViewPhysicalBlocker,
  physicalState: string | null,
  batteryState: string | null,
): string | null {
  if (blocker === "not_connected") {
    return "Connect both left and right lenses as one headset before running validation.";
  }
  if (blocker === "partial_headset") {
    return "Reconnect the whole headset so both left and right lenses are present.";
  }
  if (blocker === "in_charging_base" || blocker === "wearing_state_missing") {
    return headsetValidationBlocker(physicalState, batteryState);
  }
  if (blocker === "evidence_missing") {
    return "Run check, then guided validation to capture display, settings, side taps, mic writes, and audio.";
  }
  return null;
}

export function viewNextAction(blocker: ViewPhysicalBlocker): string | null {
  if (blocker === "not_connected") return "Connect Headset";
  if (blocker === "partial_headset") return "Reconnect the missing lens";
  if (blocker === "in_charging_base") {
    return "Remove the glasses from the charging base and wear them";
  }
  if (blocker === "wearing_state_missing") {
    return "Wear the glasses until wearing state appears";
  }
  if (blocker === "evidence_missing") return "Run Check and Guided Validation";
  return null;
}

export function viewCommandName(data: Uint8Array): string {
  switch (data[0]) {
    case 0x01:
      return "brightness";
    case 0x0e:
      return "open-mic";
    case 0x1c:
      return "silent-mode";
    case 0x2c:
      return "battery-status";
    case 0x34:
      return "get-serial";
    case 0x4d:
      return "init";
    case 0x4e:
      return "display-result";
    case 0xf4:
      return "right-init";
    default:
      return data.length > 0
        ? `0x${data[0].toString(16).padStart(2, "0")}`
        : "empty";
  }
}

export function buildViewDisplayPackets(
  text: string,
  options: {
    startSeq?: number;
    mode?: "ai" | "text";
    includeCompletion?: boolean;
  } = {},
): { packets: Uint8Array[]; pages: number; nextSeq: number } {
  const mode = options.mode ?? "ai";
  let seq = options.startSeq ?? 0;
  const packets: Uint8Array[] = [];
  const pages = paginateDisplayText(text);
  for (const [pageIndex, page] of pages.entries()) {
    packets.push(
      ...encodeTextPackets(
        withViewScreenStatus(page, viewStreamingStatus(mode, pageIndex)),
        seq,
      ),
    );
    seq = (seq + 1) & 0xff;
  }
  if (mode !== "text" && options.includeCompletion !== false) {
    const lastPage = pages.at(-1);
    if (lastPage) {
      packets.push(
        ...encodeTextPackets(
          withViewScreenStatus(lastPage, G1AiStatus.DisplayComplete),
          seq,
        ),
      );
      seq = (seq + 1) & 0xff;
    }
  }
  return { packets, pages: pages.length, nextSeq: seq };
}

function withViewScreenStatus(
  page: DisplayPage,
  screenStatus: number,
): DisplayPage {
  return { ...page, screenStatus };
}

function viewStreamingStatus(mode: "ai" | "text", pageIndex: number): number {
  if (mode === "text") return G1TextStatus.TextShow | G1ScreenAction.NewContent;
  return pageIndex === 0
    ? G1AiStatus.Displaying | G1ScreenAction.NewContent
    : G1AiStatus.Displaying;
}

function bytesToHex(data: Uint8Array): string {
  return [...data].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseWifiNetworks(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const value = result as Record<string, unknown>;
  const networks =
    value.networks ??
    value.wifiNetworks ??
    value.accessPoints ??
    value.networks_neo ??
    value.results;
  if (!Array.isArray(networks)) return [];
  return networks
    .map((network) => {
      if (typeof network === "string") return network;
      if (network && typeof network === "object") {
        const record = network as Record<string, unknown>;
        return String(record.ssid ?? record.SSID ?? record.name ?? "");
      }
      return "";
    })
    .map((network) => network.trim())
    .filter((network) => network.length > 0);
}

export function formatWifiStatus(
  result: unknown,
  fallback = "Wi-Fi status requested",
): string {
  if (!result || typeof result !== "object") return fallback;
  const value = result as Record<string, unknown>;
  const explicitStatus = value.status ?? value.state ?? value.message;
  if (typeof explicitStatus === "string" && explicitStatus.trim()) {
    return explicitStatus.trim();
  }
  const connected = value.connected ?? value.wifiConnected;
  const ssid = value.ssid ?? value.wifiSsid ?? value.SSID;
  const localIp = value.localIp ?? value.wifiLocalIp ?? value.ipAddress;
  if (connected === true) {
    return `Connected to ${String(ssid ?? "Wi-Fi")}${
      localIp ? ` at ${String(localIp)}` : ""
    }`;
  }
  if (connected === false) return "Wi-Fi disconnected";
  return fallback;
}

export async function callWifiBridge(
  bridge: SmartglassesBridge,
  command: string,
  payload?: Record<string, unknown>,
): Promise<unknown> {
  if (command === "request_wifi_scan" && bridge.requestWifiScan) {
    return bridge.requestWifiScan();
  }
  if (command === "request_wifi_status" && bridge.requestWifiStatus) {
    return bridge.requestWifiStatus();
  }
  if (command === "request_wifi_setup" && bridge.requestWifiSetup) {
    return bridge.requestWifiSetup(String(payload?.reason ?? ""));
  }
  if (command === "set_wifi_credentials") {
    const ssid = String(payload?.ssid ?? "");
    const password = String(payload?.password ?? "");
    if (bridge.setWifiCredentials) {
      return bridge.setWifiCredentials(ssid, password);
    }
    if (bridge.sendWifiCredentials) {
      return bridge.sendWifiCredentials(ssid, password);
    }
  }
  if (bridge.rawBridge?.callEvenApp) {
    return bridge.rawBridge.callEvenApp(command, payload);
  }
  throw new Error(
    `Native smartglasses bridge does not support Wi-Fi command: ${command}`,
  );
}

export function SmartglassesView() {
  const [transport, setTransport] = useState<SmartglassesTransport | null>(
    null,
  );
  const [lenses, setLenses] = useState<Record<GlassSide, LensState>>({
    left: "idle",
    right: "idle",
  });
  const [events, setEvents] = useState<ReportEvent[]>([]);
  const [writes, setWrites] = useState<ReportWrite[]>([]);
  const [audioChunks, setAudioChunks] = useState<ReportAudio[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testText, setTestText] = useState(
    "Eliza smartglasses connected. Display, mic, serial, settings.",
  );
  const [micEnabled, setMicEnabled] = useState(false);
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [wifiStatus, setWifiStatus] = useState("Not checked");
  const [wifiNetworks, setWifiNetworks] = useState<string[]>([]);
  const [activePlatform, setActivePlatform] = useState<PlatformKey>("desktop");
  const [physicalState, setPhysicalState] = useState<string | null>(null);
  const [batteryState, setBatteryState] = useState<string | null>(null);
  const [batteryLevels, setBatteryLevels] = useState<
    Partial<Record<GlassSide, number>>
  >({});
  const [deviceState, setDeviceState] = useState<string | null>(null);
  const [serialNumber, setSerialNumber] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, boolean>>({
    headsetConnected: false,
    init: false,
    display: false,
    serial: false,
    serialObserved: false,
    settings: false,
    microphone: false,
    micEnableWrite: false,
    micDisableWrite: false,
    tapMicEnable: false,
    tapMicDisable: false,
    audio: false,
    transcript: false,
    eventStream: false,
  });
  const testsRef = useRef(tests);
  const displaySeqRef = useRef(0);

  const bridge = getBridge();
  const webBluetoothAvailable = Boolean(getWebBluetoothG1Transport());
  const headsetConnected =
    lenses.left === "connected" && lenses.right === "connected";
  const missingEvidence = useMemo(
    () =>
      missingViewEvidence(
        tests,
        lenses,
        physicalState,
        batteryState,
        events,
        writes,
      ),
    [batteryState, events, lenses, physicalState, tests, writes],
  );
  const physicalBlocker = useMemo(
    () =>
      viewPhysicalBlocker(
        tests,
        lenses,
        physicalState,
        batteryState,
        events,
        writes,
      ),
    [batteryState, events, lenses, physicalState, tests, writes],
  );
  const report = useMemo<HardwareReport>(
    () => ({
      ok: missingEvidence.length === 0,
      generatedAt: now(),
      transport: transport?.name ?? (bridge ? "native-bridge" : null),
      connected: headsetConnected,
      lenses,
      scanDiagnosis: viewScanDiagnosis(lenses),
      physicalBlocker,
      setupHint: viewSetupHint(physicalBlocker, physicalState, batteryState),
      nextAction: viewNextAction(physicalBlocker),
      serialNumber,
      tests,
      missingEvidence,
      events,
      writes,
      audio: audioChunks,
      wifi: {
        available: Boolean(bridge),
        status: wifiStatus,
        networks: wifiNetworks,
      },
      headsetState: {
        physical: physicalState,
        battery: batteryState,
        batteryLevels,
        device: deviceState,
      },
    }),
    [
      bridge,
      audioChunks,
      events,
      headsetConnected,
      lenses,
      missingEvidence,
      physicalBlocker,
      physicalState,
      serialNumber,
      tests,
      transport,
      batteryState,
      batteryLevels,
      deviceState,
      wifiNetworks,
      wifiStatus,
      writes,
    ],
  );

  const { ref: connectRef, agentProps: connectAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "setup-connect-headset",
      role: "button",
      label: "Connect Headset",
      group: "setup",
      status: headsetConnected ? "active" : "inactive",
      description:
        "Pair both left and right smartglasses lenses as one headset",
    });
  const { ref: runCheckRef, agentProps: runCheckAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "test-run-check",
      role: "button",
      label: "Run Check",
      group: "test",
      description: "Request serial/battery and send display/settings packets",
    });
  const { ref: testTextRef, agentProps: testTextAgentProps } =
    useAgentElement<HTMLTextAreaElement>({
      id: "test-display-text",
      role: "textarea",
      label: "Display test text",
      group: "test",
      description: "Text sent to the smartglasses display during tests",
      getValue: () => testText,
      onFill: (value) => setTestText(value),
    });
  const { ref: wifiSsidRef, agentProps: wifiSsidAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "wifi-ssid",
      role: "text-input",
      label: "Wi-Fi SSID",
      group: "wifi",
      description: "SSID of the Wi-Fi network to configure on the glasses",
      getValue: () => wifiSsid,
      onFill: (value) => setWifiSsid(value),
    });
  const { ref: wifiPasswordRef, agentProps: wifiPasswordAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "wifi-password",
      role: "text-input",
      label: "Wi-Fi password",
      group: "wifi",
      description: "Password for the Wi-Fi network to configure on the glasses",
      getValue: () => wifiPassword,
      onFill: (value) => setWifiPassword(value),
    });

  function appendEvent(type: string, detail: string): void {
    setEvents((current) =>
      [...current, { at: now(), type, detail }].slice(-80),
    );
  }

  function markTest(id: string, value = true): void {
    setTests((current) => {
      const next = { ...current, [id]: value };
      testsRef.current = next;
      return next;
    });
  }

  function recordWrite(side: GlassSide | "both", data: Uint8Array): void {
    setWrites((current) =>
      [
        ...current,
        {
          at: now(),
          side,
          command: viewCommandName(data),
          bytes: data.length,
          hex: bytesToHex(data.slice(0, 24)),
        },
      ].slice(-120),
    );
  }

  async function writeSide(
    nextTransport: SmartglassesTransport,
    side: GlassSide,
    data: Uint8Array,
  ): Promise<void> {
    await nextTransport.write(side, data);
    recordWrite(side, data);
  }

  async function writeBoth(
    nextTransport: SmartglassesTransport,
    data: Uint8Array,
  ): Promise<void> {
    await nextTransport.writeBoth(data);
    recordWrite("both", data);
  }

  async function setTransportMic(
    nextTransport: SmartglassesTransport,
    enabled: boolean,
  ): Promise<void> {
    await nextTransport.openMicrophone(enabled);
    recordWrite("right", Uint8Array.from([0x0e, enabled ? 1 : 0]));
  }

  async function connectHeadset(): Promise<void> {
    setBusy("connect");
    setError(null);
    try {
      const nextTransport =
        transport ??
        (bridge
          ? new EvenBridgeTransport(bridge)
          : new WebBluetoothG1Transport());
      setTransport(nextTransport);
      const eventDispose = nextTransport.onEvent((event: G1Event) => {
        markTest("eventStream");
        if (event.stateCategory === "physical") {
          setPhysicalState(event.stateName ?? event.label ?? null);
        } else if (event.stateCategory === "battery") {
          setBatteryState(event.stateName ?? event.label ?? null);
        } else if (event.stateCategory === "device") {
          setDeviceState(event.stateName ?? event.label ?? null);
        }
        if (
          event.type === "battery-status" &&
          typeof event.batteryPercent === "number"
        ) {
          setBatteryLevels((current) => ({
            ...current,
            [event.side]: event.batteryPercent,
          }));
        }
        if (event.type === "serial" && event.serialNumber) {
          setSerialNumber(event.serialNumber);
          markTest("serialObserved");
        }
        if (isMicEnableTap(event.label)) {
          markTest("tapMicEnable");
          setMicEnabled(true);
          const eventAt = now();
          setEvents((current) =>
            [
              ...current,
              { at: eventAt, type: "tap", detail: event.label ?? "" },
            ].slice(-80),
          );
          void nextTransport
            .openMicrophone(true)
            .then(() => {
              recordWrite("right", Uint8Array.from([0x0e, 1]));
              markTest("microphone");
              markTest("micEnableWrite");
              appendEvent("microphone", "Enabled by tap");
            })
            .catch((err) => appendEvent("error", normalizeError(err)));
        }
        if (isMicDisableTap(event.label)) {
          markTest("tapMicDisable");
          setMicEnabled(false);
          const eventAt = now();
          setEvents((current) =>
            [
              ...current,
              { at: eventAt, type: "tap", detail: event.label ?? "" },
            ].slice(-80),
          );
          void nextTransport
            .openMicrophone(false)
            .then(() => {
              recordWrite("right", Uint8Array.from([0x0e, 0]));
              markTest("microphone");
              markTest("micDisableWrite");
              appendEvent("microphone", "Disabled by tap");
            })
            .catch((err) => appendEvent("error", normalizeError(err)));
        }
        appendEvent(
          "event",
          `${event.side} ${event.type}${event.label ? ` ${event.label}` : ""}`,
        );
      });
      const audioDispose = nextTransport.onAudio(
        (audio, sampleRate, side, encoding, sequence) => {
          if (audio.byteLength > 0) markTest("audio");
          setAudioChunks((current) =>
            [
              ...current,
              {
                at: now(),
                side,
                sampleRate,
                encoding: encoding ?? null,
                sequence,
                bytes: audio.byteLength,
              },
            ].slice(-80),
          );
          appendEvent(
            "audio",
            `${side} ${audio.byteLength} bytes @ ${sampleRate}Hz${
              encoding ? ` ${encoding}` : ""
            }`,
          );
        },
      );
      const transcriptDispose =
        "onTranscript" in nextTransport && nextTransport.onTranscript
          ? nextTransport.onTranscript((text, isFinal) => {
              markTest("transcript");
              appendEvent(
                "transcript",
                `${isFinal ? "final" : "partial"} ${text}`,
              );
            })
          : undefined;
      try {
        if (nextTransport instanceof WebBluetoothG1Transport) {
          await connectLens(nextTransport, "left");
          await connectLens(nextTransport, "right");
        } else {
          await nextTransport.connect();
          setLenses({ left: "connected", right: "connected" });
        }
      } catch (err) {
        eventDispose();
        audioDispose();
        transcriptDispose?.();
        throw err;
      }
      await writeSide(nextTransport, "left", encodeConnectionReady("left"));
      await writeSide(nextTransport, "right", encodeConnectionReady("right"));
      markTest("headsetConnected");
      markTest("init");
      appendEvent("connect", "Whole headset connected");
    } catch (err) {
      setError(normalizeError(err));
      appendEvent("error", normalizeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function connectLens(
    nextTransport: WebBluetoothG1Transport,
    side: GlassSide,
  ): Promise<void> {
    setLenses((current) => ({ ...current, [side]: "prompting" }));
    appendEvent("pairing", `Select the ${side} lens in the Bluetooth picker`);
    try {
      await timeout(
        nextTransport.connectLens(side),
        60_000,
        `Timed out connecting the ${side} lens`,
      );
      setLenses((current) => ({ ...current, [side]: "connected" }));
      appendEvent("connect", `${side} lens connected`);
    } catch (err) {
      setLenses((current) => ({ ...current, [side]: "failed" }));
      throw err;
    }
  }

  async function requireTransport(): Promise<SmartglassesTransport> {
    if (!transport || !headsetConnected) {
      throw new Error("Connect the whole headset before running this test");
    }
    return transport;
  }

  async function sendDisplay(): Promise<void> {
    setBusy("display");
    setError(null);
    try {
      const nextTransport = await requireTransport();
      const display = buildViewDisplayPackets(testText, {
        startSeq: displaySeqRef.current,
      });
      displaySeqRef.current = display.nextSeq;
      for (const packet of display.packets) {
        await writeBoth(nextTransport, packet);
      }
      markTest("display");
      appendEvent("display", `Sent ${display.pages} display page(s)`);
    } catch (err) {
      setError(normalizeError(err));
      appendEvent("error", normalizeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function clearDisplay(): Promise<void> {
    setBusy("clear");
    setError(null);
    try {
      const nextTransport = await requireTransport();
      await writeBoth(nextTransport, encodeClearScreen());
      appendEvent("display", "Cleared display");
    } catch (err) {
      setError(normalizeError(err));
      appendEvent("error", normalizeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function runHardwareCheck(): Promise<void> {
    setBusy("check");
    setError(null);
    try {
      const nextTransport = await requireTransport();
      await writeSide(nextTransport, "left", encodeGetSerial());
      await writeBoth(nextTransport, encodeBatteryStatusRequest());
      await writeBoth(nextTransport, encodeBrightness(32));
      await writeBoth(nextTransport, encodeSilentMode(false));
      markTest("serial");
      markTest("settings");
      appendEvent("test", "Requested serial/battery and sent settings packets");
      await sendDisplay();
    } catch (err) {
      setError(normalizeError(err));
      appendEvent("error", normalizeError(err));
      setBusy(null);
    }
  }

  async function runGuidedValidation(): Promise<void> {
    setBusy("guided");
    setError(null);
    let nextTransport: SmartglassesTransport | null = null;
    try {
      nextTransport = await requireTransport();
      const blocker = headsetValidationBlocker(physicalState, batteryState);
      if (blocker) {
        throw new Error(blocker);
      }
      await setTransportMic(nextTransport, false);
      setMicEnabled(false);
      markTest("microphone");
      markTest("micDisableWrite");

      const display = buildViewDisplayPackets(
        "Validation: single tap, speak clearly, then double tap.",
        { startSeq: displaySeqRef.current },
      );
      displaySeqRef.current = display.nextSeq;
      for (const packet of display.packets) {
        await writeBoth(nextTransport, packet);
      }
      markTest("display");
      appendEvent("validation", "Single tap, speak clearly, then double tap");

      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const current = testsRef.current;
        if (current.tapMicEnable && current.audio && current.tapMicDisable) {
          appendEvent("validation", "Side-tap microphone validation passed");
          return;
        }
        await sleep(500);
      }

      const current = testsRef.current;
      const missing = [
        !current.tapMicEnable && "tap mic enable",
        !current.audio && "right/bridge audio",
        !current.tapMicDisable && "tap mic disable",
      ].filter(Boolean);
      throw new Error(`Guided validation missing: ${missing.join(", ")}`);
    } catch (err) {
      setError(normalizeError(err));
      appendEvent("error", normalizeError(err));
    } finally {
      try {
        if (nextTransport) {
          await setTransportMic(nextTransport, false);
          setMicEnabled(false);
        }
      } catch {
        // The validation result should preserve the original failure.
      }
      setBusy(null);
    }
  }

  async function toggleMic(enabled: boolean): Promise<void> {
    setBusy(enabled ? "mic-on" : "mic-off");
    setError(null);
    try {
      const nextTransport = await requireTransport();
      await setTransportMic(nextTransport, enabled);
      setMicEnabled(enabled);
      markTest("microphone");
      markTest(enabled ? "micEnableWrite" : "micDisableWrite");
      appendEvent("microphone", enabled ? "Enabled" : "Disabled");
    } catch (err) {
      setError(normalizeError(err));
      appendEvent("error", normalizeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function scanWifi(): Promise<void> {
    setBusy("wifi-scan");
    setError(null);
    try {
      if (!bridge)
        throw new Error("No native smartglasses bridge is available");
      const result = await callWifiBridge(bridge, "request_wifi_scan");
      const networks = parseWifiNetworks(result);
      setWifiNetworks(networks);
      setWifiStatus(
        networks.length > 0
          ? `Found ${networks.length} network(s)`
          : "Scan requested; waiting for bridge results",
      );
      appendEvent("wifi", "Requested Wi-Fi scan through bridge");
    } catch (err) {
      setError(normalizeError(err));
      setWifiStatus(normalizeError(err));
      appendEvent("error", normalizeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function refreshWifiStatus(): Promise<void> {
    setBusy("wifi-status");
    setError(null);
    try {
      if (!bridge)
        throw new Error("No native smartglasses bridge is available");
      const result = await callWifiBridge(bridge, "request_wifi_status");
      const networks = parseWifiNetworks(result);
      if (networks.length > 0) setWifiNetworks(networks);
      setWifiStatus(formatWifiStatus(result));
      appendEvent("wifi", "Requested Wi-Fi status through bridge");
    } catch (err) {
      setError(normalizeError(err));
      setWifiStatus(normalizeError(err));
      appendEvent("error", normalizeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function configureWifi(): Promise<void> {
    setBusy("wifi-configure");
    setError(null);
    try {
      if (!bridge)
        throw new Error("No native smartglasses bridge is available");
      if (!wifiSsid.trim()) throw new Error("Enter a Wi-Fi SSID");
      await callWifiBridge(bridge, "set_wifi_credentials", {
        ssid: wifiSsid.trim(),
        password: wifiPassword,
      });
      setWifiStatus(`Credentials sent for ${wifiSsid.trim()}`);
      appendEvent("wifi", `Sent credentials for ${wifiSsid.trim()}`);
    } catch (err) {
      setError(normalizeError(err));
      setWifiStatus(normalizeError(err));
      appendEvent("error", normalizeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function requestWifiSetup(): Promise<void> {
    setBusy("wifi-setup");
    setError(null);
    try {
      if (!bridge)
        throw new Error("No native smartglasses bridge is available");
      await callWifiBridge(bridge, "request_wifi_setup", {
        reason: "Eliza smartglasses setup",
      });
      setWifiStatus("Native Wi-Fi setup requested");
      appendEvent("wifi", "Requested native Wi-Fi setup flow");
    } catch (err) {
      setError(normalizeError(err));
      setWifiStatus(normalizeError(err));
      appendEvent("error", normalizeError(err));
    } finally {
      setBusy(null);
    }
  }

  async function copyReport(): Promise<void> {
    window.facewearSmartglassesReport = report;
    await navigator.clipboard?.writeText(JSON.stringify(report, null, 2));
    appendEvent("report", "Copied diagnostics report");
  }

  function downloadReport(): void {
    window.facewearSmartglassesReport = report;
    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `smartglasses-report-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    appendEvent("report", "Downloaded diagnostics report");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg text-txt">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Glasses className="h-4 w-4 text-accent" />
              <h1 className="text-sm font-semibold">Smartglasses</h1>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <MiniBadge label="Pairing" />
              <MiniBadge label="Diagnostics" />
              <MiniBadge label="Wi-Fi bridge" />
              <MiniBadge label="Report" />
            </div>
          </div>
          <StatusPill
            ok={headsetConnected}
            label={headsetConnected ? "Headset connected" : "Not connected"}
          />
        </div>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <section className="space-y-4">
          <Panel>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Setup</h2>
              </div>
              <button
                ref={connectRef}
                type="button"
                onClick={() => void connectHeadset()}
                disabled={(!bridge && !webBluetoothAvailable) || busy !== null}
                aria-label="Connect Headset"
                className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
                {...connectAgentProps}
              >
                <Bluetooth className="h-4 w-4" />
                Connect Headset
              </button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <LensStatus side="left" state={lenses.left} />
              <LensStatus side="right" state={lenses.right} />
            </div>
            {!webBluetoothAvailable && (
              <p className="mt-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted">
                Web Bluetooth unavailable. Use a native bridge or Chrome/Edge.
              </p>
            )}
            <HeadsetStateHint
              physicalState={physicalState}
              batteryState={batteryState}
              deviceState={deviceState}
            />
          </Panel>

          <Panel>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Test</h2>
              </div>
              <button
                ref={runCheckRef}
                type="button"
                onClick={() => void runHardwareCheck()}
                disabled={!headsetConnected || busy !== null}
                aria-label="Run Check"
                className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
                {...runCheckAgentProps}
              >
                <RefreshCw className="h-4 w-4" />
                Run Check
              </button>
            </div>
            <textarea
              ref={testTextRef}
              value={testText}
              onChange={(event) => setTestText(event.target.value)}
              rows={4}
              aria-label="Display test text"
              className="mt-4 w-full resize-none rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              {...testTextAgentProps}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <ActionButton
                onClick={sendDisplay}
                disabled={!headsetConnected || busy !== null}
                agentId="test-send-display"
                agentLabel="Send Display"
                agentGroup="test"
                agentDescription="Send the display test text to the smartglasses"
              >
                Send Display
              </ActionButton>
              <ActionButton
                onClick={clearDisplay}
                disabled={!headsetConnected || busy !== null}
                agentId="test-clear-display"
                agentLabel="Clear Display"
                agentGroup="test"
                agentDescription="Clear the smartglasses display"
              >
                Clear
              </ActionButton>
              <ActionButton
                onClick={() => toggleMic(!micEnabled)}
                disabled={!headsetConnected || busy !== null}
                agentId="test-toggle-mic"
                agentLabel={micEnabled ? "Turn Mic Off" : "Turn Mic On"}
                agentGroup="test"
                agentDescription="Toggle the smartglasses microphone on or off"
              >
                <Mic className="h-4 w-4" />
                {micEnabled ? "Mic Off" : "Mic On"}
              </ActionButton>
              <ActionButton
                onClick={runGuidedValidation}
                disabled={!headsetConnected || busy !== null}
                agentId="test-guided-validation"
                agentLabel="Guided Validation"
                agentGroup="test"
                agentDescription="Run the guided side-tap and microphone validation flow"
              >
                Guided Validation
              </ActionButton>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {(Object.entries(tests) as Array<[string, boolean]>).map(
                ([id, ok]) => (
                  <CheckRow key={id} ok={ok} label={labelForTest(id)} />
                ),
              )}
            </div>
          </Panel>

          <Panel>
            <div className="flex items-center gap-2">
              <Wifi className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold">Wi-Fi</h2>
            </div>
            <p className="mt-1 text-xs text-muted">Native bridge only.</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <input
                ref={wifiSsidRef}
                value={wifiSsid}
                onChange={(event) => setWifiSsid(event.target.value)}
                placeholder="SSID"
                aria-label="Wi-Fi SSID"
                className="h-9 rounded-md border border-border bg-bg px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                {...wifiSsidAgentProps}
              />
              <input
                ref={wifiPasswordRef}
                value={wifiPassword}
                onChange={(event) => setWifiPassword(event.target.value)}
                placeholder="Password"
                type="password"
                aria-label="Wi-Fi password"
                className="h-9 rounded-md border border-border bg-bg px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                {...wifiPasswordAgentProps}
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <ActionButton
                onClick={scanWifi}
                disabled={!bridge || busy !== null}
                agentId="wifi-scan"
                agentLabel="Scan Wi-Fi"
                agentGroup="wifi"
                agentDescription="Scan for nearby Wi-Fi networks through the native bridge"
              >
                Scan
              </ActionButton>
              <ActionButton
                onClick={refreshWifiStatus}
                disabled={!bridge || busy !== null}
                agentId="wifi-status"
                agentLabel="Refresh Wi-Fi Status"
                agentGroup="wifi"
                agentDescription="Refresh the current Wi-Fi connection status"
              >
                Status
              </ActionButton>
              <ActionButton
                onClick={configureWifi}
                disabled={!bridge || busy !== null}
                agentId="wifi-configure"
                agentLabel="Configure Wi-Fi"
                agentGroup="wifi"
                agentDescription="Send the entered SSID and password to the glasses"
              >
                Configure Wi-Fi
              </ActionButton>
              <ActionButton
                onClick={requestWifiSetup}
                disabled={!bridge || busy !== null}
                agentId="wifi-native-setup"
                agentLabel="Native Wi-Fi Setup"
                agentGroup="wifi"
                agentDescription="Launch the native bridge Wi-Fi setup flow"
              >
                Native Setup
              </ActionButton>
            </div>
            <p className="mt-3 text-xs text-muted">{wifiStatus}</p>
            {wifiNetworks.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {wifiNetworks.slice(0, 8).map((network) => (
                  <span
                    key={network}
                    className="rounded-md bg-muted/30 px-2 py-1 text-xs text-muted"
                  >
                    {network}
                  </span>
                ))}
              </div>
            )}
          </Panel>
        </section>

        <aside className="space-y-4">
          <Panel>
            <h2 className="text-sm font-semibold">Platform Setup</h2>
            <div className="mt-3 grid grid-cols-3 gap-1 rounded-md bg-muted/20 p-1">
              {(Object.keys(PLATFORM_COPY) as PlatformKey[]).map((key) => (
                <PlatformTabButton
                  key={key}
                  platformKey={key}
                  isActive={activePlatform === key}
                  onSelect={setActivePlatform}
                />
              ))}
            </div>
            <p className="mt-3 text-xs text-txt">
              {PLATFORM_COPY[activePlatform].primary}
            </p>
            <p className="mt-2 text-xs text-muted">
              {PLATFORM_COPY[activePlatform].secondary}
            </p>
          </Panel>

          <Panel>
            <div className="flex items-center gap-2">
              <BatteryCharging className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold">Report</h2>
            </div>
            <div className="mt-3 grid gap-2 text-xs">
              <ReportRow label="Transport" value={report.transport ?? "none"} />
              <ReportRow label="Complete" value={report.ok ? "yes" : "no"} />
              <ReportRow
                label="Serial"
                value={report.serialNumber ?? "unknown"}
              />
              <ReportRow label="Pairing" value={report.scanDiagnosis} />
              <ReportRow
                label="Blocker"
                value={report.physicalBlocker ?? "none"}
              />
              <ReportRow label="Next" value={report.nextAction ?? "none"} />
              <ReportRow
                label="Missing"
                value={
                  report.missingEvidence.length === 0
                    ? "none"
                    : String(report.missingEvidence.length)
                }
              />
              <ReportRow label="Bridge" value={bridge ? "available" : "none"} />
              <ReportRow
                label="State"
                value={
                  [physicalState, batteryState, deviceState]
                    .filter(Boolean)
                    .join(" / ") || "none"
                }
              />
              <ReportRow
                label="Battery"
                value={formatBatteryLevels(batteryLevels)}
              />
              <ReportRow label="Writes" value={String(writes.length)} />
              <ReportRow label="Audio" value={String(audioChunks.length)} />
              <ReportRow label="Events" value={String(events.length)} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <ActionButton
                onClick={copyReport}
                agentId="report-copy"
                agentLabel="Copy Report"
                agentGroup="report"
                agentDescription="Copy the smartglasses diagnostics report to the clipboard"
              >
                <Clipboard className="h-4 w-4" />
                Copy
              </ActionButton>
              <ActionButton
                onClick={downloadReport}
                agentId="report-download"
                agentLabel="Download Report"
                agentGroup="report"
                agentDescription="Download the smartglasses diagnostics report as JSON"
              >
                <Download className="h-4 w-4" />
                Download
              </ActionButton>
            </div>
          </Panel>

          <Panel>
            <div className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold">Events</h2>
            </div>
            <div className="mt-3 max-h-72 overflow-y-auto rounded-md border border-border/50 bg-muted/10">
              {events.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted">No events yet.</p>
              ) : (
                events
                  .slice()
                  .reverse()
                  .map((event) => (
                    <div
                      key={`${event.at}:${event.type}:${event.detail}`}
                      className="border-b border-border/40 px-3 py-2 last:border-b-0"
                    >
                      <p className="text-xs font-medium text-txt">
                        {event.type}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {event.detail}
                      </p>
                    </div>
                  ))
              )}
            </div>
          </Panel>
        </aside>
      </div>
      {error && (
        <div className="mx-4 mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-4">
      {children}
    </div>
  );
}

function ActionButton({
  children,
  disabled,
  onClick,
  agentId,
  agentLabel,
  agentGroup,
  agentDescription,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void | Promise<void>;
  agentId: string;
  agentLabel: string;
  agentGroup: string;
  agentDescription: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label: agentLabel,
    group: agentGroup,
    description: agentDescription,
    onActivate: () => void onClick(),
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => void onClick()}
      disabled={disabled}
      aria-label={agentLabel}
      className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted/20 disabled:cursor-not-allowed disabled:opacity-50"
      {...agentProps}
    >
      {children}
    </button>
  );
}

function PlatformTabButton({
  platformKey,
  isActive,
  onSelect,
}: {
  key?: PlatformKey;
  platformKey: PlatformKey;
  isActive: boolean;
  onSelect: (key: PlatformKey) => void;
}) {
  const label = PLATFORM_COPY[platformKey].label;
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `platform-tab-${platformKey}`,
    role: "tab",
    label: `${label} platform`,
    group: "platform-setup",
    status: isActive ? "active" : "inactive",
    description: `Show ${label} smartglasses pairing instructions`,
    onActivate: () => onSelect(platformKey),
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(platformKey)}
      aria-current={isActive ? "page" : undefined}
      aria-label={`${label} platform`}
      className={`h-8 rounded px-2 text-xs font-medium ${
        isActive ? "bg-bg text-txt shadow-sm" : "text-muted hover:text-txt"
      }`}
      {...agentProps}
    >
      {label}
    </button>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium ${
        ok
          ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300"
          : "border-border bg-muted/20 text-muted"
      }`}
    >
      {ok ? (
        <CheckCircle2 className="h-3.5 w-3.5" />
      ) : (
        <XCircle className="h-3.5 w-3.5" />
      )}
      {label}
    </span>
  );
}

function MiniBadge({ label }: { label: string }) {
  return (
    <span className="rounded-md border border-border/50 bg-muted/20 px-2 py-1 text-2xs font-medium text-muted">
      {label}
    </span>
  );
}

function LensStatus({ side, state }: { side: GlassSide; state: LensState }) {
  const ok = state === "connected";
  return (
    <div className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2">
      <div className="flex items-center gap-2">
        <Glasses className="h-4 w-4 text-muted" />
        <span className="text-sm capitalize">{side}</span>
      </div>
      <StatusPill ok={ok} label={state} />
    </div>
  );
}

function HeadsetStateHint({
  physicalState,
  batteryState,
  deviceState,
}: {
  physicalState: string | null;
  batteryState: string | null;
  deviceState: string | null;
}) {
  const states = [physicalState, batteryState, deviceState].filter(Boolean);
  const stateText = states.length > 0 ? states.join(" / ") : "No state yet";
  const blocked = isCradleOrChargingState(physicalState, batteryState);
  const ready = physicalState === "wearing";
  return (
    <div
      className={`mt-3 rounded-md border px-3 py-2 text-xs ${
        blocked
          ? "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200"
          : ready
            ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300"
            : "border-border/60 bg-muted/20 text-muted"
      }`}
    >
      <span className="font-medium">Headset state:</span> {stateText}
      {blocked && (
        <span>
          {" "}
          Remove the glasses from the charging base and wear them before tap or
          microphone validation.
        </span>
      )}
      {!blocked && !ready && (
        <span>
          {" "}
          Tap/audio validation requires the glasses to report a wearing state.
        </span>
      )}
    </div>
  );
}

function CheckRow({ ok, label }: { ok: boolean; label: string; key?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 px-3 py-2">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-green-600" />
      ) : (
        <XCircle className="h-4 w-4 text-muted" />
      )}
      <span className="text-xs">{label}</span>
    </div>
  );
}

function ReportRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted">{label}</span>
      <span className="truncate font-medium text-txt">{value}</span>
    </div>
  );
}

function formatBatteryLevels(
  levels: Partial<Record<GlassSide, number>>,
): string {
  const left = levels.left === undefined ? "unknown" : `${levels.left}%`;
  const right = levels.right === undefined ? "unknown" : `${levels.right}%`;
  return `L ${left} / R ${right}`;
}

function labelForTest(id: string): string {
  const labels: Record<string, string> = {
    headsetConnected: "Whole headset",
    init: "Init packets",
    display: "Display",
    serial: "Serial request",
    serialObserved: "Serial observed",
    settings: "Settings",
    microphone: "Microphone",
    micEnableWrite: "Mic enable write",
    micDisableWrite: "Mic disable write",
    tapMicEnable: "Tap mic enable",
    tapMicDisable: "Tap mic disable",
    audio: "Audio",
    transcript: "Transcript",
    eventStream: "Events",
  };
  return labels[id] ?? id;
}
