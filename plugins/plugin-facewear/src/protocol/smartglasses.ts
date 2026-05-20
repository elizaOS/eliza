export type GlassSide = "left" | "right";
export type G1ConnectionReadyMode = "lens-specific" | "official" | "android-f4";
export type SmartglassesAudioEncoding = "pcm16" | "lc3" | "unknown";

export const EVEN_G1_UART = {
  service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
  tx: "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
  rx: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
} as const;

export enum G1Command {
  StartAi = 0xf5,
  OpenMic = 0x0e,
  ReceiveMicData = 0xf1,
  Init = 0x4d,
  RightInit = 0xf4,
  Heartbeat = 0x25,
  Battery = 0x2c,
  SendResult = 0x4e,
  QuickNote = 0x21,
  Dashboard = 0x22,
  Notification = 0x4b,
  DashboardContent = 0x06,
  Navigation = 0x0a,
  TranslateSetup = 0x39,
  TranslateStart = 0x50,
  TranslateLanguages = 0x1c,
  TranslateOriginalText = 0x0f,
  TranslateTranslatedText = 0x0d,
  AppWhitelist = 0x04,
  ExitFunction = 0x18,
  SilentMode = 0x03,
  Brightness = 0x01,
  DashboardPosition = 0x26,
  HeadUpAngle = 0x0b,
  GlassesWear = 0x27,
  BmpData = 0x15,
  BmpCrc = 0x16,
  BmpEnd = 0x20,
  Note = 0x1e,
  GetSerial = 0x34,
}

export enum G1DashboardLayout {
  Full = "full",
  Dual = "dual",
  Minimal = "minimal",
}

export enum G1WeatherIcon {
  Nothing = 0x00,
  Night = 0x01,
  Clouds = 0x02,
  Drizzle = 0x03,
  HeavyDrizzle = 0x04,
  Rain = 0x05,
  HeavyRain = 0x06,
  Thunder = 0x07,
  Thunderstorm = 0x08,
  Snow = 0x09,
  Mist = 0x0a,
  Fog = 0x0b,
  Sand = 0x0c,
  Squalls = 0x0d,
  Tornado = 0x0e,
  FreezingRain = 0x0f,
  Sunny = 0x10,
}

export enum G1TemperatureUnit {
  Celsius = "celsius",
  Fahrenheit = "fahrenheit",
}

export enum G1TimeFormat {
  TwentyFourHour = "24h",
  TwelveHour = "12h",
}

export enum G1NavigationTurn {
  StraightDot = 0x01,
  Straight = 0x02,
  Right = 0x03,
  Left = 0x04,
  SlightRight = 0x05,
  SlightLeft = 0x06,
  StrongRight = 0x07,
  StrongLeft = 0x08,
  UTurnLeft = 0x09,
  UTurnRight = 0x0a,
  Merge = 0x0b,
  SlightRightAtFork = 0x22,
  SlightLeftAtFork = 0x23,
}

export enum G1TranslateLanguage {
  Chinese = 0x01,
  English = 0x02,
  French = 0x05,
  Dutch = 0x09,
}

export enum G1SubCommand {
  Exit = 0x00,
  PageControl = 0x01,
  Start = 0x17,
  Stop = 0x18,
}

export enum G1MicStatus {
  Disable = 0x00,
  Enable = 0x01,
}

export enum G1ResponseStatus {
  Success = 0xc9,
  Failure = 0xca,
}

export enum G1ScreenAction {
  NewContent = 0x01,
}

export enum G1AiStatus {
  Displaying = 0x30,
  DisplayComplete = 0x40,
  ManualMode = 0x50,
  NetworkError = 0x60,
}

export enum G1TextStatus {
  TextShow = 0x70,
}

export enum G1SilentModeStatus {
  Off = 0x0a,
  On = 0x0c,
}

export enum G1DashboardState {
  Off = 0x00,
  On = 0x01,
}

export enum G1GlassesWearStatus {
  Off = 0x00,
  On = 0x01,
}

export enum G1VoiceNoteSubCommand {
  RequestAudioInfo = 0x01,
  RequestAudioData = 0x02,
  DeleteAudioStream = 0x04,
  DeleteAll = 0x05,
}

export enum G1InteractionCode {
  DoubleTap = 0x00,
  SingleTap = 0x01,
  LongPress = 0x17,
  StopAiRecording = 0x18,
  SilentModeOn = 0x04,
  SilentModeOff = 0x05,
  OpenDashboardStart = 0x02,
  CloseDashboardStart = 0x03,
  OpenDashboardConfirm = 0x1e,
  CloseDashboardConfirm = 0x1f,
}

export interface DisplayPage {
  pageNumber: number;
  maxPages: number;
  text: string;
  screenStatus: number;
}

export interface G1NotificationPayload {
  msgId?: number;
  type?: number;
  appIdentifier: string;
  title: string;
  subtitle?: string;
  message: string;
  displayName?: string;
  timeS?: number;
  date?: string;
}

export interface G1DashboardTimeWeatherPayload {
  seqId?: number;
  timestampMs?: number;
  timezoneOffsetSeconds?: number;
  temperatureInCelsius: number;
  weatherIcon?: number;
  temperatureUnit?: G1TemperatureUnit;
  timeFormat?: G1TimeFormat;
}

export interface G1NavigationDirectionsPayload {
  seqId: number;
  totalDuration: string;
  totalDistance: string;
  direction: string;
  distance: string;
  speed: string;
  directionTurn: number;
  customX?: [number, number] | number[];
  customY?: number;
}

export interface G1VoiceNoteEntry {
  index: number;
  timestamp: number;
  crc: number;
}

export interface G1Event {
  side: GlassSide;
  raw: Uint8Array;
  type:
    | "state"
    | "dashboard"
    | "init"
    | "mic-response"
    | "mic-data"
    | "display-result"
    | "notification"
    | "voice-note-list"
    | "voice-note-audio"
    | "serial"
    | "battery-status"
    | "heartbeat"
    | "response"
    | "error"
    | "unknown";
  code?: number;
  label?: string;
  micEnabled?: boolean;
  micRequested?: boolean;
  responseStatus?: number;
  responseOk?: boolean;
  stateCategory?: "interaction" | "physical" | "battery" | "device";
  stateName?: string;
  audioData?: Uint8Array;
  audioEncoding?: SmartglassesAudioEncoding;
  /**
   * Decoded 16-bit PCM bytes. Direct G1 0xF1 microphone notifications are LC3
   * and are exposed through audioData instead.
   */
  audioPcm?: Uint8Array;
  sequence?: number;
  syncId?: number;
  subcommand?: number;
  displaySeq?: number;
  totalPackages?: number;
  currentPackage?: number;
  screenStatus?: number;
  charPosition?: number;
  pageNumber?: number;
  maxPages?: number;
  text?: string;
  notificationId?: number;
  notificationChunk?: Uint8Array;
  voiceNotes?: G1VoiceNoteEntry[];
  serialNumber?: string;
  totalPackets?: number;
  currentPacket?: number;
  noteIndex?: number;
  batteryPercent?: number;
  batteryFlags?: number;
  batteryVoltageMv?: number;
}

export type G1MicrophoneInteractionAction = "enable" | "disable";

export function microphoneActionForInteractionEvent(
  event: Pick<G1Event, "type" | "label">,
): G1MicrophoneInteractionAction | null {
  if (event.type !== "state") return null;
  if (event.label === "single_tap" || event.label === "long_press") {
    return "enable";
  }
  if (event.label === "double_tap" || event.label === "stop_ai_recording") {
    return "disable";
  }
  return null;
}

export const G1_DISPLAY = {
  displayWidthPx: 576,
  charsPerLine: 40,
  linesPerPage: 5,
  maxTextLength: 40 * 5,
  maxPayloadBytes: 191,
};

const G1_GLYPH_WIDTHS = new Map<string, number>(
  Object.entries({
    " ": 2,
    "!": 1,
    '"': 2,
    "#": 6,
    $: 5,
    "%": 6,
    "&": 7,
    "'": 1,
    "(": 2,
    ")": 2,
    "*": 3,
    "+": 4,
    ",": 1,
    "-": 4,
    ".": 1,
    "/": 3,
    "0": 5,
    "1": 3,
    "2": 5,
    "3": 5,
    "4": 5,
    "5": 5,
    "6": 5,
    "7": 5,
    "8": 5,
    "9": 5,
    ":": 1,
    ";": 1,
    "<": 4,
    "=": 4,
    ">": 4,
    "?": 5,
    "@": 7,
    A: 6,
    B: 5,
    C: 5,
    D: 5,
    E: 4,
    F: 4,
    G: 5,
    H: 5,
    I: 2,
    J: 3,
    K: 5,
    L: 4,
    M: 7,
    N: 5,
    O: 5,
    P: 5,
    Q: 5,
    R: 5,
    S: 5,
    T: 5,
    U: 5,
    V: 6,
    W: 7,
    X: 6,
    Y: 6,
    Z: 5,
    "[": 2,
    "\\": 3,
    "]": 2,
    "^": 4,
    _: 3,
    "`": 2,
    a: 5,
    b: 4,
    c: 4,
    d: 4,
    e: 4,
    f: 4,
    g: 4,
    h: 4,
    i: 1,
    j: 2,
    k: 4,
    l: 1,
    m: 7,
    n: 4,
    o: 4,
    p: 4,
    q: 4,
    r: 3,
    s: 4,
    t: 3,
    u: 5,
    v: 5,
    w: 7,
    x: 5,
    y: 5,
    z: 4,
    "{": 3,
    "|": 1,
    "}": 3,
    "~": 7,
  }),
);

export const G1_BMP = {
  width: 576,
  height: 136,
  bitsPerPixel: 1,
};

const INTERACTION_LABELS = new Map<number, string>([
  [G1InteractionCode.DoubleTap, "double_tap"],
  [G1InteractionCode.SingleTap, "single_tap"],
  [G1InteractionCode.LongPress, "long_press"],
  [G1InteractionCode.StopAiRecording, "stop_ai_recording"],
  [G1InteractionCode.SilentModeOn, "silent_mode_on"],
  [G1InteractionCode.SilentModeOff, "silent_mode_off"],
  [G1InteractionCode.OpenDashboardStart, "open_dashboard_start"],
  [G1InteractionCode.CloseDashboardStart, "close_dashboard_start"],
  [G1InteractionCode.OpenDashboardConfirm, "open_dashboard_confirm"],
  [G1InteractionCode.CloseDashboardConfirm, "close_dashboard_confirm"],
]);

const PHYSICAL_LABELS = new Map<number, string>([
  [0x06, "wearing"],
  [0x07, "transitioning"],
  [0x08, "cradle_open"],
  [0x09, "charged_in_cradle"],
  [0x0b, "cradle_closed"],
]);

const BATTERY_LABELS = new Map<number, string>([
  [0x09, "glasses_fully_charged"],
  [0x0e, "cradle_charging_cable_changed"],
  [0x0f, "cradle_fully_charged"],
]);

const DEVICE_LABELS = new Map<number, string>([
  [0x0a, "device_unknown_0a"],
  [0x11, "connected"],
  [0x12, "device_unknown_12"],
  [0x14, "device_unknown_14"],
  [0x15, "device_unknown_15"],
]);

function classifyStateCode(code: number | undefined): {
  category: NonNullable<G1Event["stateCategory"]>;
  label: string;
  name: string;
} | null {
  if (code === undefined) return null;
  const interaction = INTERACTION_LABELS.get(code);
  if (interaction)
    return { category: "interaction", label: interaction, name: interaction };
  const physical = PHYSICAL_LABELS.get(code);
  if (physical)
    return { category: "physical", label: physical, name: physical };
  const battery = BATTERY_LABELS.get(code);
  if (battery) return { category: "battery", label: battery, name: battery };
  const device = DEVICE_LABELS.get(code);
  if (device) return { category: "device", label: device, name: device };
  return null;
}

export function measureG1DisplayText(text: string): number {
  let width = 0;
  for (const char of text) width += measureG1DisplayChar(char);
  return width;
}

function measureG1DisplayChar(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (isKorean(codePoint)) return 24;
  if (isCjk(codePoint) || isHiragana(codePoint) || isKatakana(codePoint))
    return 18;
  if (isCyrillic(codePoint)) return 18;
  const glyphWidth = G1_GLYPH_WIDTHS.get(char);
  return glyphWidth === undefined ? 16 : (glyphWidth + 1) * 2;
}

function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff)
  );
}

function isHiragana(codePoint: number): boolean {
  return codePoint >= 0x3040 && codePoint <= 0x309f;
}

function isKatakana(codePoint: number): boolean {
  return codePoint >= 0x30a0 && codePoint <= 0x30ff;
}

function isKorean(codePoint: number): boolean {
  return codePoint >= 0xac00 && codePoint <= 0xd7af;
}

function isCyrillic(codePoint: number): boolean {
  return codePoint >= 0x0400 && codePoint <= 0x04ff;
}

function fitsG1DisplayLine(text: string, maxWidthPx: number): boolean {
  return measureG1DisplayText(text) <= maxWidthPx;
}

export function formatDisplayLines(
  text: string,
  options: number | { charsPerLine?: number; maxWidthPx?: number } = {},
): string[] {
  const charsPerLine =
    typeof options === "number" ? options : options.charsPerLine;
  const maxWidthPx =
    typeof options === "number"
      ? undefined
      : (options.maxWidthPx ?? G1_DISPLAY.displayWidthPx);
  if (charsPerLine !== undefined)
    return formatDisplayLinesByCharacters(text, charsPerLine);
  return formatDisplayLinesByPixels(
    text,
    maxWidthPx ?? G1_DISPLAY.displayWidthPx,
  );
}

function formatDisplayLinesByCharacters(
  text: string,
  charsPerLine: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text
    .split(/\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean)) {
    let rest = paragraph;
    while (rest.length > charsPerLine) {
      let splitAt = rest.lastIndexOf(" ", charsPerLine);
      if (splitAt < 1) splitAt = charsPerLine;
      lines.push(rest.slice(0, splitAt).trimEnd());
      rest = rest.slice(splitAt).trimStart();
    }
    if (rest) lines.push(rest);
  }
  return lines.length ? lines : [""];
}

function formatDisplayLinesByPixels(
  text: string,
  maxWidthPx: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) {
      if (lines.length > 0) lines.push("");
      continue;
    }
    lines.push(...wrapDisplayParagraphByPixels(trimmed, maxWidthPx));
  }
  return lines.length ? lines : [""];
}

function wrapDisplayParagraphByPixels(
  paragraph: string,
  maxWidthPx: number,
): string[] {
  if (fitsG1DisplayLine(paragraph, maxWidthPx)) return [paragraph];
  const lines: string[] = [];
  let current = "";
  for (const word of paragraph.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (fitsG1DisplayLine(candidate, maxWidthPx)) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    const wordLines = breakDisplayTokenByPixels(word, maxWidthPx);
    lines.push(...wordLines.slice(0, -1));
    current = wordLines.at(-1) ?? "";
  }
  if (current) lines.push(current);
  return lines;
}

function breakDisplayTokenByPixels(
  token: string,
  maxWidthPx: number,
): string[] {
  const lines: string[] = [];
  let current = "";
  for (const char of Array.from(token)) {
    const candidate = current + char;
    if (fitsG1DisplayLine(candidate, maxWidthPx)) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = char;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export function paginateDisplayText(
  text: string,
  options: { charsPerLine?: number; linesPerPage?: number } = {},
): DisplayPage[] {
  const charsPerLine = options.charsPerLine ?? G1_DISPLAY.charsPerLine;
  const linesPerPage = options.linesPerPage ?? G1_DISPLAY.linesPerPage;
  const lines = formatDisplayLines(
    text,
    options.charsPerLine === undefined
      ? { maxWidthPx: G1_DISPLAY.displayWidthPx }
      : { charsPerLine },
  );
  const maxPages = Math.max(1, Math.ceil(lines.length / linesPerPage));
  const pages: DisplayPage[] = [];

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const pageLines = lines.slice(
      pageIndex * linesPerPage,
      (pageIndex + 1) * linesPerPage,
    );
    const missing = linesPerPage - pageLines.length;
    if (missing > 0) {
      const before = Math.floor(missing / 2);
      const after = missing - before;
      pageLines.unshift(...Array.from({ length: before }, () => ""));
      pageLines.push(...Array.from({ length: after }, () => ""));
    }
    pages.push({
      pageNumber: pageIndex + 1,
      maxPages,
      text: pageLines.join("\n"),
      screenStatus:
        pageIndex === maxPages - 1
          ? G1AiStatus.DisplayComplete
          : G1AiStatus.Displaying | G1ScreenAction.NewContent,
    });
  }
  return pages;
}

export function encodeTextPacket(page: DisplayPage, seq = 0): Uint8Array {
  const data = new TextEncoder().encode(page.text);
  if (data.byteLength > G1_DISPLAY.maxPayloadBytes) {
    throw new RangeError(
      `G1 display payload is ${data.byteLength} bytes; use encodeTextPackets for payloads over ${G1_DISPLAY.maxPayloadBytes} bytes`,
    );
  }
  return encodeTextPacketChunk(page, data, seq, 1, 0);
}

export function encodeTextPackets(page: DisplayPage, seq = 0): Uint8Array[] {
  const chunks = splitUtf8Chunks(page.text, G1_DISPLAY.maxPayloadBytes);
  const totalPackages = chunks.length;
  const packets: Uint8Array[] = [];
  let charPosition = 0;
  for (const [currentPackage, chunk] of chunks.entries()) {
    packets.push(
      encodeTextPacketChunk(
        page,
        chunk,
        seq,
        totalPackages,
        currentPackage,
        charPosition,
      ),
    );
    charPosition += chunk.length;
  }
  return packets;
}

function splitUtf8Chunks(text: string, maxBytes: number): Uint8Array[] {
  const encoder = new TextEncoder();
  if (text.length === 0) return [new Uint8Array()];
  const chunks: Uint8Array[] = [];
  let current = "";
  for (const char of text) {
    const next = current + char;
    const nextBytes = encoder.encode(next);
    if (nextBytes.byteLength > maxBytes && current) {
      chunks.push(encoder.encode(current));
      current = char;
      continue;
    }
    if (nextBytes.byteLength > maxBytes) {
      throw new RangeError(
        `Single UTF-8 character exceeds G1 display packet payload limit of ${maxBytes} bytes`,
      );
    }
    current = next;
  }
  if (current || chunks.length === 0) chunks.push(encoder.encode(current));
  return chunks;
}

function encodeTextPacketChunk(
  page: DisplayPage,
  data: Uint8Array,
  seq: number,
  totalPackages: number,
  currentPackage: number,
  charPosition = 0,
): Uint8Array {
  const packet = new Uint8Array(9 + data.length);
  packet.set([
    G1Command.SendResult,
    seq & 0xff,
    totalPackages & 0xff,
    currentPackage & 0xff,
    page.screenStatus & 0xff,
    (charPosition >>> 8) & 0xff,
    charPosition & 0xff,
    page.pageNumber & 0xff,
    page.maxPages & 0xff,
  ]);
  packet.set(data, 9);
  return packet;
}

export function encodeMicCommand(enabled: boolean): Uint8Array {
  return Uint8Array.from([
    G1Command.OpenMic,
    enabled ? G1MicStatus.Enable : G1MicStatus.Disable,
  ]);
}

export function encodeHeartbeat(seq: number): Uint8Array {
  const s = seq & 0xff;
  return Uint8Array.from([G1Command.Heartbeat, 0x06, 0x00, s, 0x04, s]);
}

export function encodeBatteryStatusRequest(): Uint8Array {
  return Uint8Array.from([G1Command.Battery, 0x01]);
}

export function encodeConnectionReady(
  side: GlassSide,
  mode: G1ConnectionReadyMode = "lens-specific",
): Uint8Array {
  return Uint8Array.from([
    mode === "android-f4"
      ? G1Command.RightInit
      : mode === "official" || side === "left"
        ? G1Command.Init
        : G1Command.RightInit,
    0x01,
  ]);
}

export function encodeStartAi(
  subcommand: G1SubCommand,
  param: Uint8Array = new Uint8Array(),
): Uint8Array {
  const packet = new Uint8Array(2 + param.length);
  packet.set([G1Command.StartAi, subcommand]);
  packet.set(param, 2);
  return packet;
}

export function encodeExitFunction(): Uint8Array {
  return Uint8Array.from([G1Command.ExitFunction]);
}

export function encodeGetSerial(): Uint8Array {
  return Uint8Array.from([G1Command.GetSerial]);
}

export function encodeClearScreen(): Uint8Array {
  return Uint8Array.from([
    G1Command.StartAi,
    G1SubCommand.Stop,
    0x00,
    0x00,
    0x00,
  ]);
}

export function encodeSilentMode(enabled: boolean): Uint8Array {
  return Uint8Array.from([
    G1Command.SilentMode,
    enabled ? G1SilentModeStatus.On : G1SilentModeStatus.Off,
    0x00,
  ]);
}

export function encodeBrightness(level: number, auto = false): Uint8Array {
  if (!Number.isInteger(level) || level < 0 || level > 0x29) {
    throw new RangeError(
      "Brightness level must be an integer between 0 and 0x29",
    );
  }
  return Uint8Array.from([
    G1Command.Brightness,
    level & 0xff,
    auto ? 0x01 : 0x00,
  ]);
}

export function encodeDashboard(
  state: G1DashboardState | boolean,
  position = 0,
): Uint8Array {
  if (!Number.isInteger(position) || position < 0 || position > 8) {
    throw new RangeError(
      "Dashboard position must be an integer between 0 and 8",
    );
  }
  const stateValue =
    typeof state === "boolean"
      ? state
        ? G1DashboardState.On
        : G1DashboardState.Off
      : state;
  return Uint8Array.from([
    G1Command.DashboardPosition,
    0x07,
    0x00,
    0x01,
    0x02,
    stateValue,
    position & 0xff,
  ]);
}

export function encodeDashboardPosition(
  height: number,
  depth: number,
  seqId = 1,
): Uint8Array {
  if (!Number.isInteger(height) || height < 0 || height > 8) {
    throw new RangeError("Dashboard height must be an integer between 0 and 8");
  }
  if (!Number.isInteger(depth) || depth < 1 || depth > 9) {
    throw new RangeError("Dashboard depth must be an integer between 1 and 9");
  }
  return Uint8Array.from([
    G1Command.DashboardPosition,
    0x08,
    0x00,
    seqId & 0xff,
    0x02,
    0x01,
    height & 0xff,
    depth & 0xff,
  ]);
}

export function encodeDashboardLayout(layout: G1DashboardLayout): Uint8Array {
  const layoutBytes =
    layout === G1DashboardLayout.Full
      ? [0x08, 0x06, 0x00, 0x00]
      : layout === G1DashboardLayout.Dual
        ? [0x1e, 0x06, 0x01, 0x00]
        : [0x31, 0x06, 0x02, 0x00];
  return Uint8Array.from([
    G1Command.DashboardContent,
    0x07,
    0x00,
    ...layoutBytes,
  ]);
}

export function encodeDashboardCalendarItem(payload: {
  name: string;
  time: string;
  location: string;
}): Uint8Array {
  const name = new TextEncoder().encode(payload.name);
  const time = new TextEncoder().encode(payload.time);
  const location = new TextEncoder().encode(payload.location);
  for (const [field, bytes] of [
    ["name", name],
    ["time", time],
    ["location", location],
  ] as const) {
    if (bytes.length > 255)
      throw new RangeError(
        `Dashboard calendar ${field} must be at most 255 bytes`,
      );
  }
  const prefix = [
    0x00, 0x6d, 0x03, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x03, 0x01,
  ];
  const body = new Uint8Array(
    prefix.length + 6 + name.length + time.length + location.length,
  );
  let offset = 0;
  body.set(prefix, offset);
  offset += prefix.length;
  body.set([0x01, name.length], offset);
  offset += 2;
  body.set(name, offset);
  offset += name.length;
  body.set([0x02, time.length], offset);
  offset += 2;
  body.set(time, offset);
  offset += time.length;
  body.set([0x03, location.length], offset);
  offset += 2;
  body.set(location, offset);
  return Uint8Array.from([
    G1Command.DashboardContent,
    (body.length + 2) & 0xff,
    ...body,
  ]);
}

export function encodeDashboardTimeWeather(
  payload: G1DashboardTimeWeatherPayload,
): Uint8Array {
  if (
    !Number.isInteger(payload.temperatureInCelsius) ||
    payload.temperatureInCelsius < -128 ||
    payload.temperatureInCelsius > 127
  ) {
    throw new RangeError("Dashboard temperature must fit in signed 8 bits");
  }
  const seqId = payload.seqId ?? 0;
  const timestampMs = payload.timestampMs ?? Date.now();
  const timezoneOffsetSeconds =
    payload.timezoneOffsetSeconds ??
    -new Date(timestampMs).getTimezoneOffset() * 60;
  const localMs = timestampMs + timezoneOffsetSeconds * 1000;
  const out = new Uint8Array(21);
  const view = new DataView(out.buffer);
  out.set([G1Command.DashboardContent, 0x15, 0x00, seqId & 0xff, 0x01]);
  view.setUint32(5, Math.floor(localMs / 1000), true);
  view.setBigUint64(9, BigInt(Math.trunc(localMs)), true);
  out[17] = (payload.weatherIcon ?? G1WeatherIcon.Nothing) & 0xff;
  out[18] = payload.temperatureInCelsius & 0xff;
  out[19] =
    payload.temperatureUnit === G1TemperatureUnit.Fahrenheit ? 0x01 : 0x00;
  out[20] = payload.timeFormat === G1TimeFormat.TwelveHour ? 0x01 : 0x00;
  return out;
}

export function encodeHeadUpAngle(angle: number): Uint8Array {
  if (!Number.isInteger(angle) || angle < 0 || angle > 60) {
    throw new RangeError(
      "Head-up display angle must be an integer between 0 and 60",
    );
  }
  return Uint8Array.from([G1Command.HeadUpAngle, angle & 0xff, 0x01]);
}

export function encodeG1Setup(
  payload: string | Record<string, unknown> | unknown[],
): Uint8Array[] {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const data = new TextEncoder().encode(text);
  const maxPayload = 176;
  const totalPackets = Math.max(1, Math.ceil(data.byteLength / maxPayload));
  const packets: Uint8Array[] = [];
  for (let index = 0; index < totalPackets; index++) {
    const chunk = data.slice(index * maxPayload, (index + 1) * maxPayload);
    const packet = new Uint8Array(3 + chunk.length);
    packet.set([G1Command.AppWhitelist, totalPackets & 0xff, index & 0xff]);
    packet.set(chunk, 3);
    packets.push(packet);
  }
  return packets;
}

export function encodeNavigationInit(seqId: number): Uint8Array {
  return Uint8Array.from([
    G1Command.Navigation,
    0x06,
    0x00,
    seqId & 0xff,
    0x00,
    0x01,
  ]);
}

export function encodeNavigationDirections(
  payload: G1NavigationDirectionsPayload,
): Uint8Array {
  const encoder = new TextEncoder();
  const totalDuration = encoder.encode(payload.totalDuration);
  const totalDistance = encoder.encode(payload.totalDistance);
  const direction = encoder.encode(payload.direction);
  const distance = encoder.encode(payload.distance);
  const speed = encoder.encode(payload.speed);
  const customX = payload.customX ?? [0x00, 0x00];
  const body = new Uint8Array(
    8 +
      totalDuration.length +
      totalDistance.length +
      direction.length +
      distance.length +
      speed.length +
      5,
  );
  let offset = 0;
  body.set(
    [
      0x00,
      payload.seqId & 0xff,
      0x01,
      payload.directionTurn & 0xff,
      customX[0] ?? 0,
      customX[1] ?? 0,
      payload.customY ?? 0,
      0x00,
    ],
    offset,
  );
  offset += 8;
  for (const bytes of [
    totalDuration,
    totalDistance,
    direction,
    distance,
    speed,
  ]) {
    body.set(bytes, offset);
    offset += bytes.length;
    body[offset++] = 0x00;
  }
  return Uint8Array.from([
    G1Command.Navigation,
    (body.length + 2) & 0xff,
    ...body,
  ]);
}

export function encodeNavigationPrimaryImage(
  image: ArrayLike<number>,
  overlay: ArrayLike<number>,
  seqId = 0,
): Uint8Array[] {
  validateBitPlanes(image, overlay, 136 * 136, "primary navigation image");
  return encodeNavigationImagePackets(
    runLengthEncodeBits([...Array.from(image), ...Array.from(overlay)]),
    0x02,
    seqId,
    false,
  );
}

export function encodeNavigationSecondaryImage(
  image: ArrayLike<number>,
  overlay: ArrayLike<number>,
  seqId = 0,
): Uint8Array[] {
  validateBitPlanes(image, overlay, 488 * 136, "secondary navigation image");
  return encodeNavigationImagePackets(
    [...Array.from(image), ...Array.from(overlay)],
    0x03,
    seqId,
    true,
  );
}

export function encodeNavigationPoller(
  seqId: number,
  pollerSeqId: number,
): Uint8Array {
  return Uint8Array.from([
    G1Command.Navigation,
    0x06,
    0x00,
    seqId & 0xff,
    0x04,
    pollerSeqId & 0xff,
  ]);
}

export function encodeNavigationEnd(seqId: number): Uint8Array {
  return Uint8Array.from([
    G1Command.Navigation,
    0x06,
    0x00,
    seqId & 0xff,
    0x05,
    0x01,
  ]);
}

export function encodeTranslateSetup(): Uint8Array {
  return Uint8Array.from([G1Command.TranslateSetup, 0x05, 0x00, 0x00, 0x13]);
}

export function encodeTranslateStart(): Uint8Array {
  return Uint8Array.from([
    G1Command.TranslateStart,
    0x06,
    0x00,
    0x00,
    0x01,
    0x01,
  ]);
}

export function encodeTranslateLanguages(
  fromLanguage: number,
  toLanguage: number,
): Uint8Array {
  return Uint8Array.from([
    G1Command.TranslateLanguages,
    0x00,
    fromLanguage & 0xff,
    toLanguage & 0xff,
  ]);
}

export function encodeTranslateText(
  kind: "original" | "translated",
  text: string,
  syncId: number,
): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  const command =
    kind === "original"
      ? G1Command.TranslateOriginalText
      : G1Command.TranslateTranslatedText;
  return Uint8Array.from([
    command,
    syncId & 0xff,
    0x01,
    0x00,
    0x00,
    0x00,
    text ? 0x20 : 0x00,
    0x0d,
    ...encoded,
  ]);
}

export function encodeGlassesWear(enabled: boolean): Uint8Array {
  return Uint8Array.from([
    G1Command.GlassesWear,
    enabled ? G1GlassesWearStatus.On : G1GlassesWearStatus.Off,
  ]);
}

export function encodeAppWhitelist(
  whitelist: string | Record<string, unknown> | unknown[],
): Uint8Array[] {
  const text =
    typeof whitelist === "string" ? whitelist : JSON.stringify(whitelist);
  const data = new TextEncoder().encode(text);
  const maxPayload = 177;
  const totalPackets = Math.max(1, Math.ceil(data.byteLength / maxPayload));
  const packets: Uint8Array[] = [];
  for (let seq = 0; seq < totalPackets; seq++) {
    const start = seq * maxPayload;
    const chunk = data.slice(start, start + maxPayload);
    const packet = new Uint8Array(3 + chunk.length);
    packet.set([G1Command.AppWhitelist, totalPackets & 0xff, seq & 0xff]);
    packet.set(chunk, 3);
    packets.push(packet);
  }
  return packets;
}

export function encodeNoteDelete(noteNumber: number): Uint8Array {
  validateNoteNumber(noteNumber);
  return Uint8Array.from([
    G1Command.Note,
    0x10,
    0x00,
    0xe0,
    0x03,
    0x01,
    0x00,
    0x01,
    0x00,
    noteNumber,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
  ]);
}

export function encodeNoteAdd(
  noteNumber: number,
  title: string,
  text: string,
  version = Date.now(),
): Uint8Array {
  validateNoteNumber(noteNumber);
  const titleBytes = new TextEncoder().encode(title);
  const textBytes = new TextEncoder().encode(text);
  if (titleBytes.length > 255 || textBytes.length > 255) {
    throw new RangeError(
      "G1 note title and text must each encode to at most 255 bytes",
    );
  }
  const fixed = Uint8Array.from([0x03, 0x01, 0x00, 0x01, 0x00]);
  const payloadLength =
    1 +
    1 +
    fixed.length +
    1 +
    1 +
    1 +
    titleBytes.length +
    1 +
    1 +
    textBytes.length +
    2;
  const out = new Uint8Array(
    4 + fixed.length + 3 + titleBytes.length + 2 + textBytes.length,
  );
  let offset = 0;
  out.set(
    [
      G1Command.Note,
      payloadLength & 0xff,
      0x00,
      Math.floor(version / 1000) & 0xff,
    ],
    offset,
  );
  offset += 4;
  out.set(fixed, offset);
  offset += fixed.length;
  out.set([noteNumber, 0x01, titleBytes.length & 0xff], offset);
  offset += 3;
  out.set(titleBytes, offset);
  offset += titleBytes.length;
  out.set([textBytes.length & 0xff, 0x00], offset);
  offset += 2;
  out.set(textBytes, offset);
  return out;
}

export function encodeVoiceNoteFetch(
  noteIndex: number,
  syncId: number,
): Uint8Array {
  validateVoiceNoteIndex(noteIndex);
  return Uint8Array.from([
    G1Command.Note,
    0x06,
    0x00,
    syncId & 0xff,
    G1VoiceNoteSubCommand.RequestAudioData,
    noteIndex & 0xff,
  ]);
}

export function encodeVoiceNoteList(syncId: number): Uint8Array {
  return Uint8Array.from([
    G1Command.Note,
    0x06,
    0x00,
    syncId & 0xff,
    G1VoiceNoteSubCommand.RequestAudioInfo,
    0x00,
  ]);
}

export function encodeVoiceNoteDelete(
  noteIndex: number,
  syncId: number,
): Uint8Array {
  validateVoiceNoteIndex(noteIndex);
  return Uint8Array.from([
    G1Command.Note,
    0x06,
    0x00,
    syncId & 0xff,
    G1VoiceNoteSubCommand.DeleteAudioStream,
    noteIndex & 0xff,
  ]);
}

export function encodeVoiceNoteDeleteAll(syncId: number): Uint8Array {
  return Uint8Array.from([
    G1Command.Note,
    0x06,
    0x00,
    syncId & 0xff,
    G1VoiceNoteSubCommand.DeleteAll,
    0x00,
  ]);
}

export function encodeNotification(
  payload: G1NotificationPayload,
): Uint8Array[] {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const model = {
    ncs_notification: {
      msg_id: payload.msgId ?? nowSeconds,
      type: payload.type ?? 1,
      app_identifier: payload.appIdentifier,
      title: payload.title,
      subtitle: payload.subtitle ?? "",
      message: payload.message,
      time_s: payload.timeS ?? nowSeconds,
      date:
        payload.date ??
        new Date((payload.timeS ?? nowSeconds) * 1000)
          .toISOString()
          .slice(0, 19)
          .replace("T", " "),
      display_name: payload.displayName ?? payload.appIdentifier,
    },
    type: "Add",
  };
  const bytes = new TextEncoder().encode(JSON.stringify(model));
  const chunkSize = 176;
  const chunks: Uint8Array[] = [];
  const total = Math.max(1, Math.ceil(bytes.length / chunkSize));
  const packetMessageId = (payload.msgId ?? 0) & 0xff;
  for (let index = 0; index < total; index++) {
    const chunk = bytes.slice(index * chunkSize, (index + 1) * chunkSize);
    const packet = new Uint8Array(4 + chunk.length);
    packet.set([
      G1Command.Notification,
      packetMessageId,
      total & 0xff,
      index & 0xff,
    ]);
    packet.set(chunk, 4);
    chunks.push(packet);
  }
  return chunks;
}

export function encodeBmpTransfer(imageData: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  const packetSize = 194;
  for (
    let offset = 0, seq = 0;
    offset < imageData.length;
    offset += packetSize, seq++
  ) {
    const chunk = imageData.slice(offset, offset + packetSize);
    const prefix =
      seq === 0
        ? [G1Command.BmpData, seq & 0xff, 0x00, 0x1c, 0x00, 0x00]
        : [G1Command.BmpData, seq & 0xff];
    const packet = new Uint8Array(prefix.length + chunk.length);
    packet.set(prefix);
    packet.set(chunk, prefix.length);
    packets.push(packet);
  }
  packets.push(Uint8Array.from([G1Command.BmpEnd, 0x0d, 0x0e]));
  const crcInput = new Uint8Array(4 + imageData.length);
  crcInput.set([0x00, 0x1c, 0x00, 0x00]);
  crcInput.set(imageData, 4);
  const crc = crc32(crcInput);
  packets.push(
    Uint8Array.from([
      G1Command.BmpCrc,
      (crc >>> 24) & 0xff,
      (crc >>> 16) & 0xff,
      (crc >>> 8) & 0xff,
      crc & 0xff,
    ]),
  );
  return packets;
}

export function encodeG1MonochromeBmp(
  pixels: ArrayLike<number> | Uint8Array,
  options: { width?: number; height?: number; threshold?: number } = {},
): Uint8Array {
  const width = options.width ?? G1_BMP.width;
  const height = options.height ?? G1_BMP.height;
  const threshold = options.threshold ?? 128;
  if (!Number.isInteger(width) || width <= 0) {
    throw new RangeError("BMP width must be a positive integer");
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new RangeError("BMP height must be a positive integer");
  }
  const expectedPixels = width * height;
  if (pixels.length !== expectedPixels) {
    throw new RangeError(
      `Expected ${expectedPixels} monochrome pixels, got ${pixels.length}`,
    );
  }

  const rowStride = Math.ceil(width / 32) * 4;
  const pixelDataSize = rowStride * height;
  const pixelOffset = 14 + 40 + 8;
  const fileSize = pixelOffset + pixelDataSize;
  const out = new Uint8Array(fileSize);
  const view = new DataView(out.buffer);

  out.set([0x42, 0x4d], 0);
  view.setUint32(2, fileSize, true);
  view.setUint32(10, pixelOffset, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 1, true);
  view.setUint32(34, pixelDataSize, true);
  view.setUint32(46, 2, true);
  view.setUint32(50, 2, true);
  out.set([0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00], 54);

  for (let y = 0; y < height; y++) {
    const sourceY = height - 1 - y;
    const rowOffset = pixelOffset + y * rowStride;
    for (let x = 0; x < width; x++) {
      const source = pixels[sourceY * width + x] ?? 0;
      if (source < threshold) continue;
      out[rowOffset + (x >> 3)] |= 0x80 >> (x & 0x07);
    }
  }
  return out;
}

export function parseG1Notification(
  side: GlassSide,
  data: Uint8Array,
): G1Event {
  const command = data[0];
  if (command === G1Command.StartAi) {
    const code = data[1];
    const state = classifyStateCode(code);
    return {
      side,
      raw: data,
      type: "state",
      code,
      label: state?.label ?? `unknown_0x${code?.toString(16)}`,
      stateCategory: state?.category,
      stateName: state?.name,
    };
  }
  if (command === G1Command.OpenMic) {
    const responseStatus = data.length >= 3 ? data[1] : undefined;
    const requested = data[data.length - 1];
    const responseOk =
      responseStatus === undefined ||
      responseStatus === G1ResponseStatus.Success;
    const micRequested = requested === G1MicStatus.Enable;
    return {
      side,
      raw: data,
      type: "mic-response",
      micEnabled: responseOk ? micRequested : !micRequested,
      micRequested,
      responseStatus,
      responseOk,
      code: requested,
      label:
        responseOk && micRequested
          ? "mic_enabled"
          : responseOk
            ? "mic_disabled"
            : "mic_failed",
    };
  }
  if (command === G1Command.ReceiveMicData) {
    return {
      side,
      raw: data,
      type: "mic-data",
      sequence: data[1],
      audioData: data.slice(2),
      audioEncoding: "lc3",
      label: "mic_data",
    };
  }
  if (command === G1Command.Init || command === G1Command.RightInit) {
    return {
      side,
      raw: data,
      type: "init",
      code: data[1],
      label: command === G1Command.RightInit ? "right_init" : "init",
    };
  }
  if (command === G1Command.SendResult) {
    return parseDisplayResult(side, data);
  }
  if (command === G1Command.Notification) {
    return parseNotificationChunk(side, data);
  }
  if (command === G1Command.QuickNote) {
    return parseVoiceNoteList(side, data);
  }
  if (
    command === G1Command.Note &&
    data.length >= 11 &&
    data[4] === G1VoiceNoteSubCommand.RequestAudioData
  ) {
    const totalPackets = readUint16LE(data, 5);
    const currentPacket = readUint16LE(data, 7);
    const noteIndex = Math.max(0, (data[9] ?? 1) - 1);
    return {
      side,
      raw: data,
      type: "voice-note-audio",
      syncId: data[3],
      subcommand: data[4],
      totalPackets,
      currentPacket,
      noteIndex,
      sequence: currentPacket,
      audioData: data.slice(10),
      audioEncoding: "lc3",
      label: "voice_note_audio",
    };
  }
  if (command === G1Command.Dashboard) {
    const code = data[1];
    return {
      side,
      raw: data,
      type: "dashboard",
      code,
      label: `dashboard_0x${code?.toString(16).padStart(2, "0")}`,
    };
  }
  if (command === G1Command.GetSerial) {
    const serialNumber = new TextDecoder()
      .decode(data.slice(2, 18))
      .replace(/\0+$/g, "");
    return {
      side,
      raw: data,
      type: "serial",
      code: data[1],
      responseStatus: data[1],
      responseOk: data[1] === undefined || data[1] === G1ResponseStatus.Success,
      serialNumber,
      label: "serial_number",
    };
  }
  if (command === G1Command.Heartbeat) {
    return { side, raw: data, type: "heartbeat", label: "heartbeat" };
  }
  if (command === G1Command.Battery) {
    return parseBatteryStatus(side, data);
  }
  if (command === 0x03) {
    return {
      side,
      raw: data,
      type: "response",
      code: data[1],
      label: "response",
    };
  }
  if (command === 0x04) {
    return {
      side,
      raw: data,
      type: "error",
      code: data[1],
      label: `error_0x${data[1]?.toString(16).padStart(2, "0")}`,
    };
  }
  return {
    side,
    raw: data,
    type: "unknown",
    code: command,
    label: `unknown_0x${command?.toString(16)}`,
  };
}

function parseBatteryStatus(side: GlassSide, data: Uint8Array): G1Event {
  if (data.length < 6 || data[1] !== 0x66) {
    return {
      side,
      raw: data,
      type: "battery-status",
      responseStatus: data[1],
      responseOk: false,
      label: "battery_status_invalid",
    };
  }
  return {
    side,
    raw: data,
    type: "battery-status",
    responseStatus: data[1],
    responseOk: true,
    batteryPercent: data[2],
    batteryFlags: data[3],
    batteryVoltageMv: (((data[5] ?? 0) << 8) | (data[4] ?? 0)) / 10,
    label: "battery_status",
  };
}

function parseDisplayResult(side: GlassSide, data: Uint8Array): G1Event {
  if (data.length < 9) {
    return {
      side,
      raw: data,
      type: "display-result",
      label: "display_result_invalid",
    };
  }
  const textBytes = data.slice(9);
  return {
    side,
    raw: data,
    type: "display-result",
    displaySeq: data[1],
    totalPackages: data[2],
    currentPackage: data[3],
    screenStatus: data[4],
    charPosition: readUint16BE(data, 5),
    pageNumber: data[7],
    maxPages: data[8],
    text: new TextDecoder().decode(textBytes),
    label: "display_result",
  };
}

function parseNotificationChunk(side: GlassSide, data: Uint8Array): G1Event {
  if (data.length < 4) {
    return {
      side,
      raw: data,
      type: "notification",
      label: "notification_invalid",
    };
  }
  const notificationChunk = data.slice(4);
  return {
    side,
    raw: data,
    type: "notification",
    notificationId: data[1],
    totalPackages: data[2],
    currentPackage: data[3],
    notificationChunk,
    text: new TextDecoder().decode(notificationChunk),
    label: "notification",
  };
}

function parseVoiceNoteList(side: GlassSide, data: Uint8Array): G1Event {
  const length = readUint16LE(data, 1);
  const syncId = data[3];
  const subcommand = data[4];
  if (
    data.length < 6 ||
    subcommand !== G1VoiceNoteSubCommand.RequestAudioInfo
  ) {
    return {
      side,
      raw: data,
      type: "voice-note-list",
      syncId,
      subcommand,
      voiceNotes: [],
      label: "voice_note_list_invalid",
    };
  }
  const noteCount = data[5] ?? 0;
  const expectedLength = 6 + noteCount * 9;
  const boundedLength = Math.min(data.length, Math.max(length, expectedLength));
  const voiceNotes: G1VoiceNoteEntry[] = [];
  for (
    let offset = 6;
    offset + 8 < boundedLength && voiceNotes.length < noteCount;
    offset += 9
  ) {
    voiceNotes.push({
      index: data[offset],
      timestamp: readUint32LE(data, offset + 1),
      crc: readUint32LE(data, offset + 5),
    });
  }
  return {
    side,
    raw: data,
    type: "voice-note-list",
    syncId,
    subcommand,
    voiceNotes,
    label: "voice_note_list",
  };
}

export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i++)
    out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

function validateNoteNumber(noteNumber: number): void {
  if (!Number.isInteger(noteNumber) || noteNumber < 1 || noteNumber > 4) {
    throw new RangeError("Note number must be an integer between 1 and 4");
  }
}

function validateVoiceNoteIndex(noteIndex: number): void {
  if (!Number.isInteger(noteIndex) || noteIndex < 0 || noteIndex > 255) {
    throw new RangeError(
      "G1 voice note index must be an integer from 0 to 255",
    );
  }
}

function validateBitPlanes(
  image: ArrayLike<number>,
  overlay: ArrayLike<number>,
  expectedLength: number,
  label: string,
): void {
  if (image.length !== expectedLength || overlay.length !== expectedLength) {
    throw new RangeError(
      `Expected ${expectedLength} bits for ${label} and overlay`,
    );
  }
}

function runLengthEncodeBits(data: number[]): number[] {
  if (data.length === 0) return [];
  const encoded: number[] = [];
  let current = data[0] ? 1 : 0;
  let count = 1;
  for (let index = 1; index < data.length; index++) {
    const bit = data[index] ? 1 : 0;
    if (bit === current && count < 255) {
      count += 1;
      continue;
    }
    encoded.push(count, current);
    current = bit;
    count = 1;
  }
  encoded.push(count, current);
  return encoded;
}

function encodeNavigationImagePackets(
  bytes: number[],
  partType: number,
  startSeqId: number,
  includeExtraZero: boolean,
): Uint8Array[] {
  const maxPayload = 185;
  const packetCount = Math.max(1, Math.ceil(bytes.length / maxPayload));
  const packets: Uint8Array[] = [];
  let seqId = startSeqId & 0xff;
  for (let index = 0; index < packetCount; index++) {
    const chunk = bytes.slice(index * maxPayload, (index + 1) * maxPayload);
    const part = [
      0x00,
      seqId,
      partType,
      packetCount & 0xff,
      0x00,
      (index + 1) & 0xff,
      0x00,
      ...(includeExtraZero ? [0x00] : []),
      ...chunk.map((byte) => byte & 0xff),
    ];
    packets.push(
      Uint8Array.from([
        G1Command.Navigation,
        (part.length + 2) & 0xff,
        ...part,
      ]),
    );
    seqId = (seqId + 1) & 0xff;
  }
  return packets;
}

function readUint16LE(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

function readUint16BE(data: Uint8Array, offset: number): number {
  return ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0);
}

function readUint32LE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) |
      ((data[offset + 1] ?? 0) << 8) |
      ((data[offset + 2] ?? 0) << 16) |
      ((data[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
