/**
 * Smartglasses service manages Even Realities G1 transport selection, display
 * packets, dashboard updates, microphone control, and status reporting.
 */
import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  type DisplayPage,
  encodeAppWhitelist,
  encodeBatteryStatusRequest,
  encodeBmpTransfer,
  encodeBrightness,
  encodeClearScreen,
  encodeConnectionReady,
  encodeDashboard,
  encodeDashboardCalendarItem,
  encodeDashboardLayout,
  encodeDashboardPosition,
  encodeDashboardTimeWeather,
  encodeExitFunction,
  encodeG1MonochromeBmp,
  encodeG1Setup,
  encodeGetSerial,
  encodeGlassesWear,
  encodeHeadUpAngle,
  encodeHeartbeat,
  encodeMicCommand,
  encodeNavigationDirections,
  encodeNavigationEnd,
  encodeNavigationInit,
  encodeNavigationPoller,
  encodeNavigationPrimaryImage,
  encodeNavigationSecondaryImage,
  encodeNoteAdd,
  encodeNoteDelete,
  encodeNotification,
  encodeSilentMode,
  encodeStartAi,
  encodeTextPackets,
  encodeTranslateLanguages,
  encodeTranslateSetup,
  encodeTranslateStart,
  encodeTranslateText,
  encodeVoiceNoteDelete,
  encodeVoiceNoteDeleteAll,
  encodeVoiceNoteFetch,
  encodeVoiceNoteList,
  G1AiStatus,
  type G1ConnectionReadyMode,
  type G1DashboardLayout,
  type G1DashboardTimeWeatherPayload,
  type G1Event,
  type G1NavigationDirectionsPayload,
  type G1NotificationPayload,
  G1ScreenAction,
  G1SubCommand,
  G1TextStatus,
  type GlassSide,
  microphoneActionForInteractionEvent,
  paginateDisplayText,
  parseG1Notification,
  pcm16ToFloat32,
  type SmartglassesAudioEncoding,
} from "../protocol/smartglasses.ts";
import { getGlobalEvenBridgeTransport } from "../transport/even-bridge.ts";
import { getNobleG1Transport } from "../transport/noble.ts";
import type {
  SmartglassesConnectedLenses,
  SmartglassesTransport,
  SmartglassesWifiResult,
} from "../transport/types.ts";
import { getWebBluetoothG1Transport } from "../transport/web-bluetooth.ts";

export const SMARTGLASSES_SERVICE_NAME = "smartglasses";
export const SMARTGLASSES_EVENT = "SMARTGLASSES_EVENT";
export const SMARTGLASSES_AUDIO_EVENT = "SMARTGLASSES_AUDIO";
export const SMARTGLASSES_TRANSCRIPT_EVENT = "SMARTGLASSES_TRANSCRIPT";
export const SMARTGLASSES_TRANSPORT_SETTING = "SMARTGLASSES_TRANSPORT";
export const SMARTGLASSES_SCAN_TIMEOUT_SETTING = "SMARTGLASSES_SCAN_TIMEOUT_MS";
export const SMARTGLASSES_AUTO_INIT_SETTING = "SMARTGLASSES_AUTO_INIT";
export const SMARTGLASSES_INIT_MODE_SETTING = "SMARTGLASSES_INIT_MODE";
export const FACEWEAR_SMARTGLASSES_TRANSPORT_SETTING =
  "FACEWEAR_SMARTGLASSES_TRANSPORT";
export const FACEWEAR_SCAN_TIMEOUT_SETTING = "FACEWEAR_SCAN_TIMEOUT_MS";
export const FACEWEAR_AUTO_INIT_SETTING = "FACEWEAR_AUTO_INIT";
export const FACEWEAR_INIT_MODE_SETTING = "FACEWEAR_INIT_MODE";

type PreferredTransport = "auto" | "even-bridge" | "web-bluetooth" | "noble";
export type SmartglassesDisplayMode = "ai" | "text";
export type SmartglassesWriteTarget = GlassSide | "both";

export interface SmartglassesRsvpOptions {
  wordsPerGroup?: number;
  wpm?: number;
  paddingChar?: string;
  mode?: SmartglassesDisplayMode;
  skipDelay?: boolean;
}

export interface SmartglassesStatus {
  available: boolean;
  connected: boolean;
  transport: string | null;
  microphoneEnabled: boolean;
  heartbeatRunning: boolean;
  heartbeatIntervalMs: number | null;
  lastHeartbeatAt: number | null;
  lastEvent: G1Event | null;
  lastTranscript: string | null;
  audioChunksReceived: number;
  lastAudioEncoding: SmartglassesAudioEncoding | null;
  lastAudioSequence: number | null;
  audioSequenceGaps: number;
  physicalState: string | null;
  batteryState: string | null;
  batteryLevels: Partial<Record<GlassSide, number>>;
  batteryVoltagesMv: Partial<Record<GlassSide, number>>;
  deviceState: string | null;
  lastSerialNumber: string | null;
  connectedLenses: SmartglassesConnectedLenses;
  wifiAvailable: boolean;
  lastWifiStatus: SmartglassesWifiResult | null;
}

type TranscriptCallback = (text: string, isFinal: boolean) => void;
type AudioCallback = (
  pcm: Float32Array,
  sampleRate: number,
  side: GlassSide,
) => void;
type RawAudioCallback = (
  audio: Uint8Array,
  sampleRate: number,
  side: GlassSide,
  encoding: SmartglassesAudioEncoding,
  sequence?: number,
) => void;
export type SmartglassesAudioDecoder = (
  audio: Uint8Array,
  context: {
    sampleRate: number;
    side: GlassSide;
    encoding: SmartglassesAudioEncoding;
    sequence?: number;
  },
) => Uint8Array | null | undefined | Promise<Uint8Array | null | undefined>;

let injectedTransport: SmartglassesTransport | null = null;
let injectedAudioDecoder: SmartglassesAudioDecoder | null = null;

export function setSmartglassesTransportForRuntime(
  transport: SmartglassesTransport | null,
): void {
  injectedTransport = transport;
}

export function setSmartglassesAudioDecoderForRuntime(
  decoder: SmartglassesAudioDecoder | null,
): void {
  injectedAudioDecoder = decoder;
}

export class SmartglassesService extends Service {
  static serviceType = SMARTGLASSES_SERVICE_NAME;
  capabilityDescription =
    "Controls Even Realities G1/G2 smartglasses display and microphone input, including side-tap mic toggles";

  private transport: SmartglassesTransport | null = null;
  private microphoneEnabled = false;
  private lastEvent: G1Event | null = null;
  private lastTranscript: string | null = null;
  private audioChunksReceived = 0;
  private lastAudioEncoding: SmartglassesAudioEncoding | null = null;
  private lastAudioSequence: number | null = null;
  private audioSequenceGaps = 0;
  private physicalState: string | null = null;
  private batteryState: string | null = null;
  private batteryLevels: Partial<Record<GlassSide, number>> = {};
  private batteryVoltagesMv: Partial<Record<GlassSide, number>> = {};
  private deviceState: string | null = null;
  private lastSerialNumber: string | null = null;
  private lastWifiStatus: SmartglassesWifiResult | null = null;
  private displaySeq = 0;
  private heartbeatSeq = 0;
  private dashboardSeq = 0;
  private navigationSeq = 0;
  private navigationPollerSeq = 1;
  private translateSyncId = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs: number | null = null;
  private lastHeartbeatAt: number | null = null;
  private voiceNoteSyncId = 0;
  private readonly transcriptCallbacks = new Set<TranscriptCallback>();
  private readonly audioCallbacks = new Set<AudioCallback>();
  private readonly rawAudioCallbacks = new Set<RawAudioCallback>();
  private audioDecoder: SmartglassesAudioDecoder | null = injectedAudioDecoder;
  private disposers: Array<() => void> = [];

  static async start(runtime: IAgentRuntime): Promise<SmartglassesService> {
    const service = new SmartglassesService(runtime);
    service.transport = injectedTransport ?? (await chooseTransport(runtime));
    if (!service.transport) {
      logger.info(
        "[plugin-facewear/smartglasses] no transport available; service loaded in offline/mockable mode",
      );
      return service;
    }
    await service.connect();
    if (
      readBooleanSetting(
        runtime,
        [FACEWEAR_AUTO_INIT_SETTING, SMARTGLASSES_AUTO_INIT_SETTING],
        true,
      )
    ) {
      await service.sendConnectionReady(
        "both",
        readConnectionReadyModeSetting(runtime),
      );
    }
    return service;
  }

  setTransport(transport: SmartglassesTransport | null): void {
    void this.disconnect();
    this.transport = transport;
  }

  async connect(): Promise<void> {
    if (!this.transport)
      throw new Error("No smartglasses transport is configured");
    if (this.transport.isConnected()) {
      this.attachTransportListeners();
      return;
    }
    await this.transport.connect();
    this.attachTransportListeners();
  }

  private attachTransportListeners(): void {
    if (!this.transport || this.disposers.length > 0) return;
    this.disposers.push(
      this.transport.onEvent((event) => void this.handleEvent(event)),
    );
    this.disposers.push(
      this.transport.onAudio(
        (audioData, sampleRate, side, encoding, sequence) => {
          const audioEncoding = encoding ?? "pcm16";
          void this.handleAudioChunk(
            audioData,
            sampleRate,
            side,
            audioEncoding,
            sequence,
          );
        },
      ),
    );
    if (this.transport.onTranscript) {
      this.disposers.push(
        this.transport.onTranscript((text, isFinal, metadata) => {
          this.receiveTranscript(text, isFinal, metadata);
        }),
      );
    }
    if (this.transport.onWifiStatus) {
      this.disposers.push(
        this.transport.onWifiStatus((status) => {
          this.lastWifiStatus = status;
        }),
      );
    }
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeatLoop();
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.transport?.isConnected()) await this.transport.disconnect();
    this.microphoneEnabled = false;
  }

  async stop(): Promise<void> {
    await this.disconnect();
  }

  getStatus(): SmartglassesStatus {
    return {
      available: Boolean(this.transport),
      connected: this.transport?.isConnected() ?? false,
      transport: this.transport?.name ?? null,
      microphoneEnabled: this.microphoneEnabled,
      heartbeatRunning: Boolean(this.heartbeatTimer),
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastEvent: this.lastEvent,
      lastTranscript: this.lastTranscript,
      audioChunksReceived: this.audioChunksReceived,
      lastAudioEncoding: this.lastAudioEncoding,
      lastAudioSequence: this.lastAudioSequence,
      audioSequenceGaps: this.audioSequenceGaps,
      physicalState: this.physicalState,
      batteryState: this.batteryState,
      batteryLevels: { ...this.batteryLevels },
      batteryVoltagesMv: { ...this.batteryVoltagesMv },
      deviceState: this.deviceState,
      lastSerialNumber: this.lastSerialNumber,
      connectedLenses: this.transport?.getConnectedLenses?.() ?? {},
      wifiAvailable: this.isWifiAvailable(),
      lastWifiStatus: this.lastWifiStatus,
    };
  }

  async displayText(
    text: string,
    options: {
      pageHoldMs?: number;
      completionDelayMs?: number;
      mode?: SmartglassesDisplayMode;
    } = {},
  ): Promise<{ pages: number }> {
    if (!this.transport)
      throw new Error("No smartglasses transport is configured");
    if (!this.transport.isConnected()) await this.connect();
    const pages = paginateDisplayText(text);
    const mode = options.mode ?? "ai";
    for (const [index, page] of pages.entries()) {
      const seq = this.nextDisplaySeq();
      const streamingPage = withScreenStatus(
        page,
        streamingStatus(mode, index),
      );
      for (const packet of encodeTextPackets(streamingPage, seq)) {
        await this.transport.writeBoth(packet);
      }
      if (options.pageHoldMs && index < pages.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, options.pageHoldMs));
      }
    }
    if (mode === "text") return { pages: pages.length };
    if (options.completionDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, options.completionDelayMs),
      );
    }
    const lastPage = pages.at(-1);
    if (lastPage) {
      const seq = this.nextDisplaySeq();
      for (const packet of encodeTextPackets(
        withScreenStatus(lastPage, G1AiStatus.DisplayComplete),
        seq,
      )) {
        await this.transport.writeBoth(packet);
      }
    }
    return { pages: pages.length };
  }

  async displayRsvpText(
    text: string,
    options: SmartglassesRsvpOptions = {},
  ): Promise<{ groups: number; pages: number }> {
    const words = text
      .split(/\s+/)
      .map((word) => word.trim())
      .filter(Boolean);
    if (words.length === 0) return { groups: 0, pages: 0 };

    const wordsPerGroup = positiveIntegerOrDefault(options.wordsPerGroup, 1);
    const paddingChar = options.paddingChar ?? "...";
    const groups: string[] = [];
    for (let offset = 0; offset < words.length; offset += wordsPerGroup) {
      const group = words.slice(offset, offset + wordsPerGroup);
      while (group.length < wordsPerGroup) group.push(paddingChar);
      groups.push(group.join(" "));
    }

    let pages = 0;
    const delayMs = rsvpDelayMs(options.wpm, wordsPerGroup);
    for (const group of groups) {
      const result = await this.displayText(group, { mode: options.mode });
      pages += result.pages;
      if (!options.skipDelay && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return { groups: groups.length, pages };
  }

  async clearDisplay(): Promise<void> {
    await this.writeBoth(encodeClearScreen());
  }

  async sendHeartbeat(seq?: number): Promise<void> {
    const effectiveSeq = seq === undefined ? this.nextHeartbeatSeq() : seq;
    await this.writeBoth(encodeHeartbeat(effectiveSeq));
    this.lastHeartbeatAt = Date.now();
  }

  async requestBatteryStatus(
    side: SmartglassesWriteTarget = "both",
  ): Promise<void> {
    await this.sendRaw(encodeBatteryStatusRequest(), side);
  }

  startHeartbeatLoop(
    options: { intervalMs?: number; immediate?: boolean } = {},
  ): void {
    const intervalMs = positiveIntegerOrDefault(options.intervalMs, 8000);
    this.stopHeartbeatLoop();
    this.heartbeatIntervalMs = intervalMs;
    if (options.immediate !== false) void this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat().catch((error) => {
        logger.warn(
          { error },
          "[plugin-facewear/smartglasses] heartbeat failed",
        );
      });
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeatLoop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.heartbeatIntervalMs = null;
  }

  async sendConnectionReady(
    side: SmartglassesWriteTarget = "both",
    mode: G1ConnectionReadyMode = "lens-specific",
  ): Promise<void> {
    if (side === "both") {
      await this.writeSide("left", encodeConnectionReady("left", mode));
      await this.writeSide("right", encodeConnectionReady("right", mode));
      return;
    }
    await this.writeSide(side, encodeConnectionReady(side, mode));
  }

  async sendStartAi(
    subcommand: G1SubCommand,
    param: Uint8Array = new Uint8Array(),
  ): Promise<void> {
    await this.writeBoth(encodeStartAi(subcommand, param));
  }

  async exitToDashboard(): Promise<void> {
    await this.sendStartAi(G1SubCommand.Exit);
  }

  async exitFunction(): Promise<void> {
    await this.writeBoth(encodeExitFunction());
  }

  async requestSerial(side: SmartglassesWriteTarget = "both"): Promise<void> {
    await this.sendRaw(encodeGetSerial(), side);
  }

  async sendAppWhitelist(
    whitelist: string | Record<string, unknown> | unknown[],
    side: SmartglassesWriteTarget = "left",
  ): Promise<{ packets: number }> {
    const packets = encodeAppWhitelist(whitelist);
    for (const packet of packets) await this.sendRaw(packet, side);
    return { packets: packets.length };
  }

  async sendG1Setup(
    payload: string | Record<string, unknown> | unknown[],
    side: SmartglassesWriteTarget = "left",
  ): Promise<{ packets: number }> {
    const packets = encodeG1Setup(payload);
    for (const packet of packets) await this.sendRaw(packet, side);
    return { packets: packets.length };
  }

  async sendRaw(
    packet: Uint8Array,
    side: SmartglassesWriteTarget = "both",
  ): Promise<void> {
    if (side === "both") {
      await this.writeBoth(packet);
      return;
    }
    await this.writeSide(side, packet);
  }

  async pageUp(): Promise<void> {
    await this.writeSide("left", encodeStartAi(G1SubCommand.PageControl));
  }

  async pageDown(): Promise<void> {
    await this.writeSide("right", encodeStartAi(G1SubCommand.PageControl));
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    if (!this.transport)
      throw new Error("No smartglasses transport is configured");
    if (!this.transport.isConnected()) await this.connect();
    await this.transport.openMicrophone(enabled);
    this.microphoneEnabled = enabled;
  }

  async sendMicCommandPacket(enabled: boolean): Promise<void> {
    if (!this.transport)
      throw new Error("No smartglasses transport is configured");
    if (!this.transport.isConnected()) await this.connect();
    await this.transport.write("right", encodeMicCommand(enabled));
    this.microphoneEnabled = enabled;
  }

  async setSilentMode(enabled: boolean): Promise<void> {
    await this.writeBoth(encodeSilentMode(enabled));
  }

  async setBrightness(level: number, auto = false): Promise<void> {
    await this.writeBoth(encodeBrightness(level, auto));
  }

  async setDashboard(enabled: boolean, position = 0): Promise<void> {
    await this.writeBoth(encodeDashboard(enabled, position));
  }

  async setDashboardPosition(height: number, depth: number): Promise<void> {
    await this.writeBoth(
      encodeDashboardPosition(height, depth, this.nextDashboardSeq()),
    );
  }

  async setDashboardLayout(layout: G1DashboardLayout): Promise<void> {
    await this.writeBoth(encodeDashboardLayout(layout));
  }

  async sendDashboardCalendarItem(payload: {
    name: string;
    time: string;
    location: string;
  }): Promise<void> {
    await this.writeBoth(encodeDashboardCalendarItem(payload));
  }

  async sendDashboardTimeWeather(
    payload: Omit<G1DashboardTimeWeatherPayload, "seqId"> & {
      seqId?: number;
    },
  ): Promise<void> {
    await this.writeBoth(
      encodeDashboardTimeWeather({
        ...payload,
        seqId: payload.seqId ?? this.nextDashboardSeq(),
      }),
    );
  }

  async setHeadUpAngle(angle: number): Promise<void> {
    await this.writeBoth(encodeHeadUpAngle(angle));
  }

  async setGlassesWearDetection(enabled: boolean): Promise<void> {
    await this.writeBoth(encodeGlassesWear(enabled));
  }

  async scanWifi(): Promise<SmartglassesWifiResult> {
    const wifi = this.requireWifiCapability("scanWifi");
    const result = await wifi.scanWifi();
    this.lastWifiStatus = result;
    return result;
  }

  async getWifiStatus(): Promise<SmartglassesWifiResult> {
    const wifi = this.requireWifiCapability("getWifiStatus");
    const result = await wifi.getWifiStatus();
    this.lastWifiStatus = result;
    return result;
  }

  async configureWifi(
    ssid: string,
    password: string,
  ): Promise<SmartglassesWifiResult> {
    if (!ssid.trim()) throw new Error("Wi-Fi SSID is required");
    const wifi = this.requireWifiCapability("configureWifi");
    const result = await wifi.configureWifi(ssid.trim(), password);
    this.lastWifiStatus = result;
    return result;
  }

  async requestWifiSetup(reason?: string): Promise<SmartglassesWifiResult> {
    const wifi = this.requireWifiCapability("requestWifiSetup");
    const result = await wifi.requestWifiSetup(reason);
    this.lastWifiStatus = result;
    return result;
  }

  async startNavigation(): Promise<void> {
    await this.writeBoth(encodeNavigationInit(this.nextNavigationSeq()));
  }

  async sendNavigationDirections(
    payload: Omit<G1NavigationDirectionsPayload, "seqId"> & {
      seqId?: number;
    },
  ): Promise<void> {
    await this.writeBoth(
      encodeNavigationDirections({
        ...payload,
        seqId: payload.seqId ?? this.nextNavigationSeq(),
      }),
    );
  }

  async sendNavigationPrimaryImage(
    image: ArrayLike<number>,
    overlay: ArrayLike<number>,
  ): Promise<{ packets: number }> {
    const packets = encodeNavigationPrimaryImage(
      image,
      overlay,
      this.navigationSeq,
    );
    this.navigationSeq = (this.navigationSeq + packets.length) & 0xff;
    for (const packet of packets) await this.writeBoth(packet);
    return { packets: packets.length };
  }

  async sendNavigationSecondaryImage(
    image: ArrayLike<number>,
    overlay: ArrayLike<number>,
  ): Promise<{ packets: number }> {
    const packets = encodeNavigationSecondaryImage(
      image,
      overlay,
      this.navigationSeq,
    );
    this.navigationSeq = (this.navigationSeq + packets.length) & 0xff;
    for (const packet of packets) await this.writeBoth(packet);
    return { packets: packets.length };
  }

  async sendNavigationPoller(): Promise<void> {
    await this.writeBoth(
      encodeNavigationPoller(
        this.nextNavigationSeq(),
        this.nextNavigationPollerSeq(),
      ),
    );
  }

  async endNavigation(): Promise<void> {
    await this.writeBoth(encodeNavigationEnd(this.nextNavigationSeq()));
  }

  async sendTranslateSetup(): Promise<void> {
    await this.writeBoth(encodeTranslateSetup());
  }

  async startTranslate(): Promise<void> {
    await this.writeSide("right", encodeTranslateStart());
  }

  async setTranslateLanguages(
    fromLanguage: number,
    toLanguage: number,
  ): Promise<void> {
    await this.writeBoth(encodeTranslateLanguages(fromLanguage, toLanguage));
  }

  async sendTranslateText(
    kind: "original" | "translated",
    text: string,
    syncId?: number,
  ): Promise<{ syncId: number }> {
    const effectiveSyncId = syncId ?? this.nextTranslateSyncId();
    await this.writeBoth(encodeTranslateText(kind, text, effectiveSyncId));
    return { syncId: effectiveSyncId };
  }

  async addOrUpdateNote(
    noteNumber: number,
    title: string,
    text: string,
  ): Promise<void> {
    await this.writeBoth(encodeNoteAdd(noteNumber, title, text));
  }

  async deleteNote(noteNumber: number): Promise<void> {
    await this.writeBoth(encodeNoteDelete(noteNumber));
  }

  async requestVoiceNoteAudio(
    noteIndex: number,
    options: { syncId?: number; side?: GlassSide } = {},
  ): Promise<{ syncId: number }> {
    const syncId = options.syncId ?? this.nextVoiceNoteSyncId();
    await this.writeSide(
      options.side ?? "right",
      encodeVoiceNoteFetch(noteIndex, syncId),
    );
    return { syncId };
  }

  async requestVoiceNoteList(
    options: { syncId?: number; side?: GlassSide } = {},
  ): Promise<{ syncId: number }> {
    const syncId = options.syncId ?? this.nextVoiceNoteSyncId();
    await this.writeSide(options.side ?? "right", encodeVoiceNoteList(syncId));
    return { syncId };
  }

  async deleteVoiceNoteAudio(
    noteIndex: number,
    options: { syncId?: number; side?: GlassSide } = {},
  ): Promise<{ syncId: number }> {
    const syncId = options.syncId ?? this.nextVoiceNoteSyncId();
    await this.writeSide(
      options.side ?? "right",
      encodeVoiceNoteDelete(noteIndex, syncId),
    );
    return { syncId };
  }

  async deleteAllVoiceNoteAudio(
    options: { syncId?: number; side?: GlassSide } = {},
  ): Promise<{ syncId: number }> {
    const syncId = options.syncId ?? this.nextVoiceNoteSyncId();
    await this.writeSide(
      options.side ?? "right",
      encodeVoiceNoteDeleteAll(syncId),
    );
    return { syncId };
  }

  async sendNotification(
    payload: G1NotificationPayload,
  ): Promise<{ packets: number }> {
    const packets = encodeNotification(payload);
    for (const packet of packets) await this.writeBoth(packet);
    return { packets: packets.length };
  }

  async sendBmpImage(imageData: Uint8Array): Promise<{ packets: number }> {
    const packets = encodeBmpTransfer(imageData);
    for (const packet of packets) await this.writeBoth(packet);
    return { packets: packets.length };
  }

  async sendMonochromeBmpImage(
    pixels: ArrayLike<number> | Uint8Array,
    options: { width?: number; height?: number; threshold?: number } = {},
  ): Promise<{ packets: number; bytes: number }> {
    const imageData = encodeG1MonochromeBmp(pixels, options);
    const result = await this.sendBmpImage(imageData);
    return { ...result, bytes: imageData.length };
  }

  onTranscript(callback: TranscriptCallback): () => void {
    this.transcriptCallbacks.add(callback);
    return () => this.transcriptCallbacks.delete(callback);
  }

  onAudio(callback: AudioCallback): () => void {
    this.audioCallbacks.add(callback);
    return () => this.audioCallbacks.delete(callback);
  }

  onRawAudio(callback: RawAudioCallback): () => void {
    this.rawAudioCallbacks.add(callback);
    return () => this.rawAudioCallbacks.delete(callback);
  }

  setAudioDecoder(decoder: SmartglassesAudioDecoder | null): void {
    this.audioDecoder = decoder;
  }

  receiveTranscript(
    text: string,
    isFinal = true,
    metadata?: Record<string, unknown>,
  ): void {
    this.lastTranscript = text;
    for (const callback of this.transcriptCallbacks) callback(text, isFinal);
    void this.emitPluginEvent(SMARTGLASSES_TRANSCRIPT_EVENT, {
      text,
      isFinal,
      metadata,
    });
  }

  async receiveExternalRawEvent(
    side: GlassSide,
    data: Uint8Array,
    options: { applyControls?: boolean } = {},
  ): Promise<G1Event> {
    const event = parseG1Notification(side, data);
    await this.handleEvent(event, options);
    return event;
  }

  async receiveExternalAudioChunk(
    audioData: Uint8Array,
    options: {
      sampleRate?: number;
      side?: GlassSide;
      encoding?: SmartglassesAudioEncoding;
      sequence?: number;
    } = {},
  ): Promise<void> {
    await this.handleAudioChunk(
      audioData,
      options.sampleRate ?? 16_000,
      options.side ?? "right",
      options.encoding ?? "lc3",
      options.sequence,
    );
  }

  private async handleAudioChunk(
    audioData: Uint8Array,
    sampleRate: number,
    side: GlassSide,
    audioEncoding: SmartglassesAudioEncoding,
    sequence?: number,
  ): Promise<void> {
    this.audioChunksReceived += 1;
    this.lastAudioEncoding = audioEncoding;
    if (sequence !== undefined) {
      if (
        this.lastAudioSequence !== null &&
        ((this.lastAudioSequence + 1) & 0xff) !== sequence
      ) {
        this.audioSequenceGaps += 1;
      }
      this.lastAudioSequence = sequence;
    }
    for (const callback of this.rawAudioCallbacks)
      callback(audioData, sampleRate, side, audioEncoding, sequence);

    const payload: Record<string, unknown> = {
      side,
      sampleRate,
      audioData,
      audioEncoding,
      audioSequenceGaps: this.audioSequenceGaps,
    };
    if (sequence !== undefined) payload.sequence = sequence;

    const audioPcm =
      audioEncoding === "pcm16"
        ? audioData
        : await this.decodeAudioChunk(
            audioData,
            sampleRate,
            side,
            audioEncoding,
            sequence,
          );
    if (audioPcm) {
      const pcm = pcm16ToFloat32(audioPcm);
      for (const callback of this.audioCallbacks)
        callback(pcm, sampleRate, side);
      payload.audioPcm = audioPcm;
      payload.decodedAudioEncoding = "pcm16";
    }

    void this.emitPluginEvent(SMARTGLASSES_AUDIO_EVENT, {
      ...payload,
    });
  }

  private async decodeAudioChunk(
    audioData: Uint8Array,
    sampleRate: number,
    side: GlassSide,
    audioEncoding: SmartglassesAudioEncoding,
    sequence?: number,
  ): Promise<Uint8Array | null> {
    if (!this.audioDecoder) return null;
    try {
      return (
        (await this.audioDecoder(audioData, {
          sampleRate,
          side,
          encoding: audioEncoding,
          sequence,
        })) ?? null
      );
    } catch (error) {
      logger.warn(
        { error },
        "[plugin-facewear/smartglasses] audio decoder failed; raw audio event preserved",
      );
      return null;
    }
  }

  private async handleEvent(
    event: G1Event,
    options: { applyControls?: boolean } = {},
  ): Promise<void> {
    this.lastEvent = event;
    void this.emitPluginEvent(SMARTGLASSES_EVENT, { event });
    if (
      event.type === "mic-response" &&
      typeof event.micEnabled === "boolean"
    ) {
      this.microphoneEnabled = event.micEnabled;
    }
    if (event.type === "state") {
      if (event.stateCategory === "physical") {
        this.physicalState = event.stateName ?? event.label ?? null;
      } else if (event.stateCategory === "battery") {
        this.batteryState = event.stateName ?? event.label ?? null;
      } else if (event.stateCategory === "device") {
        this.deviceState = event.stateName ?? event.label ?? null;
      }
      const applyControls = options.applyControls !== false;
      const microphoneAction = microphoneActionForInteractionEvent(event);
      if (microphoneAction) {
        const enabled = microphoneAction === "enable";
        if (applyControls) await this.setMicrophoneEnabled(enabled);
        else this.microphoneEnabled = enabled;
      }
      if (applyControls && event.label === "scroll_up") await this.pageUp();
      if (applyControls && event.label === "scroll_down") await this.pageDown();
    }
    if (event.type === "serial" && event.serialNumber) {
      this.lastSerialNumber = event.serialNumber;
    }
    if (
      event.type === "battery-status" &&
      typeof event.batteryPercent === "number"
    ) {
      this.batteryLevels[event.side] = event.batteryPercent;
      if (typeof event.batteryVoltageMv === "number") {
        this.batteryVoltagesMv[event.side] = event.batteryVoltageMv;
      }
    }
  }

  private async writeBoth(packet: Uint8Array): Promise<void> {
    if (!this.transport)
      throw new Error("No smartglasses transport is configured");
    if (!this.transport.isConnected()) await this.connect();
    await this.transport.writeBoth(packet);
  }

  private async writeSide(side: GlassSide, packet: Uint8Array): Promise<void> {
    if (!this.transport)
      throw new Error("No smartglasses transport is configured");
    if (!this.transport.isConnected()) await this.connect();
    await this.transport.write(side, packet);
  }

  private requireWifiCapability<
    K extends
      | "scanWifi"
      | "getWifiStatus"
      | "configureWifi"
      | "requestWifiSetup",
  >(
    method: K,
  ): SmartglassesTransport & Required<Pick<SmartglassesTransport, K>> {
    if (!this.transport)
      throw new Error("No smartglasses transport is configured");
    if (!this.isWifiAvailable() || !this.transport[method]) {
      throw new Error(
        "Wi-Fi is only available through a native smartglasses bridge transport",
      );
    }
    return this.transport as SmartglassesTransport &
      Required<Pick<SmartglassesTransport, K>>;
  }

  private isWifiAvailable(): boolean {
    if (!this.transport) return false;
    if (this.transport.supportsWifi) return this.transport.supportsWifi();
    return Boolean(
      this.transport.scanWifi ||
        this.transport.getWifiStatus ||
        this.transport.configureWifi ||
        this.transport.requestWifiSetup,
    );
  }

  private nextDisplaySeq(): number {
    const seq = this.displaySeq & 0xff;
    this.displaySeq = (this.displaySeq + 1) & 0xff;
    return seq;
  }

  private nextHeartbeatSeq(): number {
    const seq = this.heartbeatSeq & 0xff;
    this.heartbeatSeq = (this.heartbeatSeq + 1) & 0xff;
    return seq;
  }

  private nextDashboardSeq(): number {
    const seq = this.dashboardSeq & 0xff;
    this.dashboardSeq = (this.dashboardSeq + 1) & 0xff;
    return seq;
  }

  private nextNavigationSeq(): number {
    const seq = this.navigationSeq & 0xff;
    this.navigationSeq = (this.navigationSeq + 1) & 0xff;
    return seq;
  }

  private nextNavigationPollerSeq(): number {
    const seq = this.navigationPollerSeq & 0xff;
    this.navigationPollerSeq = (this.navigationPollerSeq + 1) & 0xff;
    return seq;
  }

  private nextVoiceNoteSyncId(): number {
    const syncId = this.voiceNoteSyncId & 0xff;
    this.voiceNoteSyncId = (this.voiceNoteSyncId + 1) & 0xff;
    return syncId;
  }

  private nextTranslateSyncId(): number {
    this.translateSyncId = (this.translateSyncId + 1) & 0xff;
    return this.translateSyncId;
  }

  private async emitPluginEvent(
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.runtime) return;
    await this.runtime.emitEvent(eventName, {
      runtime: this.runtime,
      source: "@elizaos/plugin-facewear",
      ...payload,
    });
  }
}

export function getSmartglassesService(
  runtime: IAgentRuntime,
): SmartglassesService | null {
  return (
    runtime.getService<SmartglassesService>(SMARTGLASSES_SERVICE_NAME) ?? null
  );
}

async function chooseTransport(
  runtime: IAgentRuntime,
): Promise<SmartglassesTransport | null> {
  const preferred = normalizePreferredTransport(
    readFirstSetting(runtime, [
      FACEWEAR_SMARTGLASSES_TRANSPORT_SETTING,
      SMARTGLASSES_TRANSPORT_SETTING,
    ]),
  );
  const scanTimeoutMs = readPositiveIntegerSetting(runtime, [
    FACEWEAR_SCAN_TIMEOUT_SETTING,
    SMARTGLASSES_SCAN_TIMEOUT_SETTING,
  ]);

  if (preferred === "even-bridge") return getGlobalEvenBridgeTransport();
  if (preferred === "web-bluetooth") return getWebBluetoothG1Transport();
  if (preferred === "noble") return getNobleG1Transport({ scanTimeoutMs });

  return (
    getGlobalEvenBridgeTransport() ??
    getWebBluetoothG1Transport() ??
    (await getNobleG1Transport({ scanTimeoutMs }))
  );
}

function readSetting(runtime: IAgentRuntime, key: string): unknown {
  return (
    runtime.getSetting?.(key) ??
    (typeof process !== "undefined" ? process.env[key] : undefined)
  );
}

function readFirstSetting(runtime: IAgentRuntime, keys: string[]): unknown {
  for (const key of keys) {
    const value = readSetting(runtime, key);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function normalizePreferredTransport(value: unknown): PreferredTransport {
  if (typeof value !== "string") return "auto";
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "even-bridge" ||
    normalized === "web-bluetooth" ||
    normalized === "noble"
  ) {
    return normalized;
  }
  return "auto";
}

function readPositiveIntegerSetting(
  runtime: IAgentRuntime,
  keys: string | string[],
): number | undefined {
  const value = Array.isArray(keys)
    ? readFirstSetting(runtime, keys)
    : readSetting(runtime, keys);
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readBooleanSetting(
  runtime: IAgentRuntime,
  keys: string | string[],
  fallback: boolean,
): boolean {
  const value = Array.isArray(keys)
    ? readFirstSetting(runtime, keys)
    : readSetting(runtime, keys);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    if (/^(false|0|no|off|disabled)$/i.test(value.trim())) return false;
    if (/^(true|1|yes|on|enabled)$/i.test(value.trim())) return true;
  }
  return fallback;
}

function readConnectionReadyModeSetting(
  runtime: IAgentRuntime,
): G1ConnectionReadyMode {
  const value = String(
    readFirstSetting(runtime, [
      FACEWEAR_INIT_MODE_SETTING,
      SMARTGLASSES_INIT_MODE_SETTING,
    ]) ?? "",
  )
    .trim()
    .toLowerCase();
  if (
    value === "official" ||
    value === "official-app" ||
    value === "even-demo-app" ||
    value === "same-init"
  )
    return "official";
  if (
    value === "android-f4" ||
    value === "android" ||
    value === "even-demo-android" ||
    value === "f4"
  )
    return "android-f4";
  return "lens-specific";
}

function withScreenStatus(
  page: DisplayPage,
  screenStatus: number,
): DisplayPage {
  return { ...page, screenStatus };
}

function streamingStatus(
  mode: SmartglassesDisplayMode,
  pageIndex: number,
): number {
  if (mode === "text") return G1TextStatus.TextShow | G1ScreenAction.NewContent;
  return pageIndex === 0
    ? G1AiStatus.Displaying | G1ScreenAction.NewContent
    : G1AiStatus.Displaying;
}

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function rsvpDelayMs(wpm: unknown, wordsPerGroup: number): number {
  if (!Number.isFinite(wpm) || Number(wpm) <= 0) return 0;
  return Math.max(0, Math.round((60_000 / Number(wpm)) * wordsPerGroup));
}
