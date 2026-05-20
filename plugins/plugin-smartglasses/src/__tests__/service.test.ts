import { describe, expect, it } from "vitest";
import {
  G1AiStatus,
  G1Command,
  G1DashboardLayout,
  G1ScreenAction,
  G1SubCommand,
  G1TextStatus,
} from "../protocol.js";
import {
  SMARTGLASSES_AUDIO_EVENT,
  SMARTGLASSES_AUTO_INIT_SETTING,
  SMARTGLASSES_EVENT,
  SMARTGLASSES_INIT_MODE_SETTING,
  SMARTGLASSES_TRANSCRIPT_EVENT,
  SMARTGLASSES_TRANSPORT_SETTING,
  SmartglassesService,
  setSmartglassesAudioDecoderForRuntime,
  setSmartglassesTransportForRuntime,
} from "../services/smartglasses-service.js";
import { MockSmartglassesTransport } from "../transport/mock.js";

describe("SmartglassesService", () => {
  it("streams display text to both glasses with G1 packets", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);

    await service.displayText("hello smartglasses");

    expect(transport.writes).toHaveLength(4);
    expect(transport.writes.map((w) => w.side)).toEqual([
      "left",
      "right",
      "left",
      "right",
    ]);
    expect(
      transport.writes.every((w) => w.data[0] === G1Command.SendResult),
    ).toBe(true);
    expect(transport.writes.map((w) => w.data[4])).toEqual([
      G1AiStatus.Displaying | G1ScreenAction.NewContent,
      G1AiStatus.Displaying | G1ScreenAction.NewContent,
      G1AiStatus.DisplayComplete,
      G1AiStatus.DisplayComplete,
    ]);
    expect(transport.writes.map((w) => w.data[1])).toEqual([0, 0, 1, 1]);
  });

  it("can use the direct Text Show display mode", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);

    await service.displayText("plain text display", { mode: "text" });

    expect(transport.writes).toHaveLength(2);
    expect(transport.writes.map((write) => write.data[4])).toEqual([
      G1TextStatus.TextShow | G1ScreenAction.NewContent,
      G1TextStatus.TextShow | G1ScreenAction.NewContent,
    ]);
  });

  it("streams RSVP word groups through the display packet path", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);

    const result = await service.displayRsvpText("one two three", {
      wordsPerGroup: 2,
      paddingChar: "...",
      mode: "text",
      skipDelay: true,
    });

    expect(result).toEqual({ groups: 2, pages: 2 });
    const displayWrites = transport.writes.filter(
      (write) => write.data[0] === G1Command.SendResult,
    );
    expect(displayWrites).toHaveLength(4);
    expect(displayWrites.map((write) => write.data[4])).toEqual([
      G1TextStatus.TextShow | G1ScreenAction.NewContent,
      G1TextStatus.TextShow | G1ScreenAction.NewContent,
      G1TextStatus.TextShow | G1ScreenAction.NewContent,
      G1TextStatus.TextShow | G1ScreenAction.NewContent,
    ]);
    const text = displayWrites
      .filter((write) => write.side === "left")
      .map((write) => new TextDecoder().decode(write.data.slice(9)))
      .join("\n");
    expect(text).toContain("one two");
    expect(text).toContain("three ...");
  });

  it("keeps rolling display and heartbeat sequence counters", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);

    await service.displayText("first");
    await service.displayText("second");
    await service.sendHeartbeat();
    await service.sendHeartbeat();

    const displaySeqs = transport.writes
      .filter((write) => write.data[0] === G1Command.SendResult)
      .map((write) => write.data[1]);
    const heartbeatSeqs = transport.writes
      .filter((write) => write.data[0] === G1Command.Heartbeat)
      .map((write) => write.data[3]);

    expect(displaySeqs).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(heartbeatSeqs).toEqual([0, 0, 1, 1]);
  });

  it("can run and stop the managed heartbeat loop", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);

    service.startHeartbeatLoop({ intervalMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.getStatus()).toMatchObject({
      heartbeatRunning: true,
      heartbeatIntervalMs: 20,
    });
    expect(service.getStatus().lastHeartbeatAt).toEqual(expect.any(Number));
    expect(
      transport.writes.filter((write) => write.data[0] === G1Command.Heartbeat),
    ).toHaveLength(2);

    service.stopHeartbeatLoop();
    expect(service.getStatus()).toMatchObject({
      heartbeatRunning: false,
      heartbeatIntervalMs: null,
    });
    await service.stop();
  });

  it("sends dashboard content, navigation, setup, and translation packets", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);

    await service.setDashboardLayout(G1DashboardLayout.Minimal);
    await service.sendDashboardCalendarItem({
      name: "Test G1",
      time: "13:30-14:30",
      location: "Home",
    });
    await service.sendDashboardTimeWeather({
      seqId: 7,
      timestampMs: 1_700_000_000_000,
      timezoneOffsetSeconds: 0,
      temperatureInCelsius: 21,
      weatherIcon: 0x10,
    });
    await service.sendG1Setup({ calendar_enable: true });
    await service.startNavigation();
    await service.sendNavigationDirections({
      totalDuration: "4 min",
      totalDistance: "1 km",
      direction: "Main St",
      distance: "200 m",
      speed: "30",
      directionTurn: 0x03,
    });
    await service.sendNavigationPoller();
    await service.endNavigation();
    await service.sendTranslateSetup();
    await service.startTranslate();
    await service.setTranslateLanguages(0x02, 0x05);
    await service.sendTranslateText("translated", "bonjour", 3);

    expect(
      transport.writes.some(
        (write) =>
          write.data[0] === G1Command.DashboardContent &&
          write.data[3] === 0x31,
      ),
    ).toBe(true);
    expect(
      transport.writes.some(
        (write) =>
          write.data[0] === G1Command.DashboardContent &&
          new TextDecoder().decode(write.data).includes("Test G1"),
      ),
    ).toBe(true);
    expect(
      transport.writes.some(
        (write) =>
          write.data[0] === G1Command.AppWhitelist &&
          new TextDecoder()
            .decode(write.data.slice(3))
            .includes("calendar_enable"),
      ),
    ).toBe(true);
    expect(
      transport.writes.filter((write) => write.data[0] === G1Command.Navigation)
        .length,
    ).toBeGreaterThanOrEqual(4);
    expect(
      transport.writes.some(
        (write) => write.data[0] === G1Command.TranslateSetup,
      ),
    ).toBe(true);
    expect(
      transport.writes.some(
        (write) =>
          write.side === "right" && write.data[0] === G1Command.TranslateStart,
      ),
    ).toBe(true);
    expect(
      transport.writes.some(
        (write) => write.data[0] === G1Command.TranslateTranslatedText,
      ),
    ).toBe(true);
  });

  it("streams multi-packet display pages to both lenses", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);

    await service.displayText("界".repeat(80));

    expect(transport.writes).toHaveLength(8);
    expect(transport.writes.map((write) => write.side)).toEqual([
      "left",
      "right",
      "left",
      "right",
      "left",
      "right",
      "left",
      "right",
    ]);
    expect(transport.writes.map((write) => write.data[2])).toEqual([
      2, 2, 2, 2, 2, 2, 2, 2,
    ]);
    expect(transport.writes.map((write) => write.data[3])).toEqual([
      0, 0, 1, 1, 0, 0, 1, 1,
    ]);
    expect(transport.writes.map((write) => write.data[4])).toEqual([
      G1AiStatus.Displaying | G1ScreenAction.NewContent,
      G1AiStatus.Displaying | G1ScreenAction.NewContent,
      G1AiStatus.Displaying | G1ScreenAction.NewContent,
      G1AiStatus.Displaying | G1ScreenAction.NewContent,
      G1AiStatus.DisplayComplete,
      G1AiStatus.DisplayComplete,
      G1AiStatus.DisplayComplete,
      G1AiStatus.DisplayComplete,
    ]);
  });

  it("single tap enables and double tap disables the right microphone", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.connect();

    transport.emitRaw("right", Uint8Array.from([0xf5, 0x01]));
    await Promise.resolve();
    expect(service.getStatus().microphoneEnabled).toBe(true);
    expect(Array.from(transport.writes.at(-1)?.data ?? [])).toEqual([
      G1Command.OpenMic,
      1,
    ]);

    transport.emitRaw("right", Uint8Array.from([0xf5, 0x00]));
    await Promise.resolve();
    expect(service.getStatus().microphoneEnabled).toBe(false);
    expect(Array.from(transport.writes.at(-1)?.data ?? [])).toEqual([
      G1Command.OpenMic,
      0,
    ]);
  });

  it("long press starts the right microphone and recording stop disables it", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.connect();

    await service.setMicrophoneEnabled(false);
    transport.emitRaw("left", Uint8Array.from([0xf5, 0x17]));
    await Promise.resolve();
    expect(service.getStatus().microphoneEnabled).toBe(true);
    expect(Array.from(transport.writes.at(-1)?.data ?? [])).toEqual([
      G1Command.OpenMic,
      1,
    ]);

    transport.emitRaw("left", Uint8Array.from([0xf5, 0x17]));
    await Promise.resolve();
    expect(service.getStatus().microphoneEnabled).toBe(true);
    expect(Array.from(transport.writes.at(-1)?.data ?? [])).toEqual([
      G1Command.OpenMic,
      1,
    ]);

    transport.emitRaw("left", Uint8Array.from([0xf5, 0x18]));
    await Promise.resolve();
    expect(service.getStatus().microphoneEnabled).toBe(false);
    expect(Array.from(transport.writes.at(-1)?.data ?? [])).toEqual([
      G1Command.OpenMic,
      0,
    ]);
  });

  it("does not keep microphone enabled after a failed open-mic response", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.setMicrophoneEnabled(true);

    expect(service.getStatus().microphoneEnabled).toBe(true);
    transport.emitRaw("right", Uint8Array.from([0x0e, 0xca, 0x01]));
    await Promise.resolve();

    expect(service.getStatus().microphoneEnabled).toBe(false);
    expect(service.getStatus().lastEvent).toMatchObject({
      type: "mic-response",
      responseOk: false,
      micRequested: true,
      label: "mic_failed",
    });
  });

  it("preserves dashboard hardware events in service status", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.connect();

    transport.emitRaw(
      "left",
      Uint8Array.from([0x22, 0x02, 0, 0, 0, 0, 0, 0, 0]),
    );
    await Promise.resolve();

    expect(service.getStatus().lastEvent).toMatchObject({
      type: "dashboard",
      code: 0x02,
      label: "dashboard_0x02",
    });
  });

  it("tracks serial number responses in service status", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.connect();

    transport.emitRaw(
      "right",
      Uint8Array.from([
        G1Command.GetSerial,
        0xc9,
        ...new TextEncoder().encode("G1RIGHTSERIAL001"),
        0,
      ]),
    );
    await Promise.resolve();

    expect(service.getStatus()).toMatchObject({
      lastSerialNumber: "G1RIGHTSERIAL001",
      lastEvent: {
        type: "serial",
        label: "serial_number",
      },
    });
  });

  it("subscribes to events when the injected transport is already connected", async () => {
    const transport = new MockSmartglassesTransport();
    await transport.connect();
    const service = new SmartglassesService();
    service.setTransport(transport);

    await service.connect();
    transport.emitRaw(
      "right",
      Uint8Array.from([
        G1Command.GetSerial,
        0xc9,
        ...new TextEncoder().encode("PRECONNECTED001"),
        0,
      ]),
    );
    await Promise.resolve();

    expect(service.getStatus()).toMatchObject({
      connected: true,
      lastSerialNumber: "PRECONNECTED001",
      lastEvent: {
        type: "serial",
        label: "serial_number",
      },
    });
  });

  it("maps bridge scroll events to manual page controls", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.connect();

    transport.emitEvent({
      side: "right",
      raw: Uint8Array.from([G1Command.StartAi, G1SubCommand.PageControl]),
      type: "state",
      code: G1SubCommand.PageControl,
      label: "scroll_up",
    });
    transport.emitEvent({
      side: "right",
      raw: Uint8Array.from([G1Command.StartAi, G1SubCommand.PageControl]),
      type: "state",
      code: G1SubCommand.PageControl,
      label: "scroll_down",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.writes.slice(-2).map((write) => write.side)).toEqual([
      "left",
      "right",
    ]);
    expect(
      transport.writes.slice(-2).map((write) => Array.from(write.data)),
    ).toEqual([
      [G1Command.StartAi, G1SubCommand.PageControl],
      [G1Command.StartAi, G1SubCommand.PageControl],
    ]);
  });

  it("tracks physical, battery, and device states in service status", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);
    await service.connect();

    transport.emitRaw("left", Uint8Array.from([0xf5, 0x06]));
    transport.emitRaw("left", Uint8Array.from([0xf5, 0x0e]));
    transport.emitRaw("right", Uint8Array.from([0xf5, 0x11]));
    await Promise.resolve();

    expect(service.getStatus()).toMatchObject({
      physicalState: "wearing",
      batteryState: "cradle_charging_cable_changed",
      deviceState: "connected",
    });
  });

  it("does not report Wi-Fi as available for transports without Wi-Fi support", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    transport.supportsWifi = () => false;
    service.setTransport(transport);

    expect(service.getStatus().wifiAvailable).toBe(false);
    await expect(service.scanWifi()).rejects.toThrow(/Wi-Fi/);
  });

  it("emits raw LC3 metadata for direct G1 microphone chunks", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    const seen: number[][] = [];
    const rawSeen: Array<{
      bytes: number[];
      encoding: string;
      sequence?: number;
    }> = [];
    service.setTransport(transport);
    service.onAudio((pcm) => seen.push(Array.from(pcm)));
    service.onRawAudio((audio, _sampleRate, _side, encoding, sequence) =>
      rawSeen.push({ bytes: Array.from(audio), encoding, sequence }),
    );
    await service.connect();

    transport.emitRaw("right", Uint8Array.from([0xf1, 1, 0, 0, 0, 64]));
    transport.emitRaw("right", Uint8Array.from([0xf1, 3, 1, 2]));

    expect(seen).toEqual([]);
    expect(rawSeen).toEqual([
      { bytes: [0, 0, 0, 64], encoding: "lc3", sequence: 1 },
      { bytes: [1, 2], encoding: "lc3", sequence: 3 },
    ]);
    expect(service.getStatus()).toMatchObject({
      audioChunksReceived: 2,
      lastAudioEncoding: "lc3",
      lastAudioSequence: 3,
      audioSequenceGaps: 1,
    });
  });

  it("uses an injected decoder for direct G1 LC3 microphone chunks", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    const seen: number[][] = [];
    const decoderCalls: Array<{
      bytes: number[];
      encoding: string;
      sequence?: number;
    }> = [];
    service.setTransport(transport);
    service.setAudioDecoder((audio, context) => {
      decoderCalls.push({
        bytes: Array.from(audio),
        encoding: context.encoding,
        sequence: context.sequence,
      });
      return Uint8Array.from([0, 0, 0, 64]);
    });
    service.onAudio((pcm) => seen.push(Array.from(pcm)));
    await service.connect();

    transport.emitRaw("right", Uint8Array.from([0xf1, 9, 1, 2, 3, 4]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(decoderCalls).toEqual([
      { bytes: [1, 2, 3, 4], encoding: "lc3", sequence: 9 },
    ]);
    expect(seen).toEqual([[0, 0.5]]);
  });

  it("can inject an LC3 decoder before service construction", async () => {
    const transport = new MockSmartglassesTransport();
    const seen: number[][] = [];
    setSmartglassesAudioDecoderForRuntime(() => Uint8Array.from([0, 64]));

    try {
      const service = new SmartglassesService();
      service.setTransport(transport);
      service.onAudio((pcm) => seen.push(Array.from(pcm)));
      await service.connect();
      transport.emitRaw("right", Uint8Array.from([0xf1, 1, 1, 2]));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(seen).toEqual([[0.5]]);
      await service.stop();
    } finally {
      setSmartglassesAudioDecoderForRuntime(null);
    }
  });

  it("emits decoded PCM callbacks for bridge PCM microphone chunks", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    const seen: number[][] = [];
    service.setTransport(transport);
    service.onAudio((pcm) => seen.push(Array.from(pcm)));
    await service.connect();

    transport.emitEvent({
      side: "right",
      raw: Uint8Array.from([]),
      type: "mic-data",
      audioPcm: Uint8Array.from([0, 0, 0, 64]),
      audioEncoding: "pcm16",
    });

    expect(seen).toEqual([[0, 0.5]]);
    expect(service.getStatus().lastAudioEncoding).toBe("pcm16");
  });

  it("emits Eliza runtime events for glass events, audio, and transcripts", async () => {
    const emitted: Array<{ event: string; params: Record<string, unknown> }> =
      [];
    const runtime = {
      emitEvent: async (event: string, params: Record<string, unknown>) => {
        emitted.push({ event, params });
      },
    };
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService(runtime as never);
    service.setTransport(transport);
    await service.connect();

    transport.emitRaw("right", Uint8Array.from([0xf1, 1, 0, 0]));
    transport.emitRaw("right", Uint8Array.from([0xf5, 0x01]));
    transport.emitTranscript("hello", true, { source: "local_transcription" });
    await Promise.resolve();

    expect(emitted.map((entry) => entry.event)).toContain(
      SMARTGLASSES_AUDIO_EVENT,
    );
    expect(emitted.map((entry) => entry.event)).toContain(SMARTGLASSES_EVENT);
    expect(emitted.map((entry) => entry.event)).toContain(
      SMARTGLASSES_TRANSCRIPT_EVENT,
    );
    expect(service.getStatus().lastTranscript).toBe("hello");
    expect(
      emitted.some(
        (entry) =>
          entry.event === SMARTGLASSES_TRANSCRIPT_EVENT &&
          entry.params.text === "hello" &&
          (entry.params.metadata as { source?: string } | undefined)?.source ===
            "local_transcription",
      ),
    ).toBe(true);
  });

  it("honors the configured transport preference during service startup", async () => {
    const writes: unknown[] = [];
    const previousBridge = (globalThis as Record<string, unknown>).__evenBridge;
    (globalThis as Record<string, unknown>).__evenBridge = {
      write: async (side: string, data: Uint8Array) => {
        writes.push({ side, data });
      },
    };
    const runtime = {
      getSetting: (key: string) => {
        if (key === SMARTGLASSES_TRANSPORT_SETTING) return "even-bridge";
        if (key === SMARTGLASSES_AUTO_INIT_SETTING) return false;
        return undefined;
      },
    };

    try {
      const service = await SmartglassesService.start(runtime as never);
      expect(service.getStatus().transport).toBe("even-bridge");
      expect(service.getStatus().connected).toBe(true);
      await service.setMicrophoneEnabled(true);
      expect(writes).toHaveLength(1);
      await service.stop();
    } finally {
      if (previousBridge === undefined) {
        delete (globalThis as Record<string, unknown>).__evenBridge;
      } else {
        (globalThis as Record<string, unknown>).__evenBridge = previousBridge;
      }
    }
  });

  it("sends connection-ready init packets during Eliza-managed startup by default", async () => {
    const transport = new MockSmartglassesTransport();
    setSmartglassesTransportForRuntime(transport);
    try {
      const service = await SmartglassesService.start({} as never);
      expect(
        transport.writes.slice(-2).map((write) => Array.from(write.data)),
      ).toEqual([
        [G1Command.Init, 0x01],
        [G1Command.RightInit, 0x01],
      ]);
      await service.stop();
    } finally {
      setSmartglassesTransportForRuntime(null);
    }
  });

  it("honors official EvenDemoApp init mode during Eliza-managed startup", async () => {
    const transport = new MockSmartglassesTransport();
    setSmartglassesTransportForRuntime(transport);
    try {
      const service = await SmartglassesService.start({
        getSetting: (key: string) =>
          key === SMARTGLASSES_INIT_MODE_SETTING ? "official" : undefined,
      } as never);
      expect(
        transport.writes.slice(-2).map((write) => Array.from(write.data)),
      ).toEqual([
        [G1Command.Init, 0x01],
        [G1Command.Init, 0x01],
      ]);
      await service.stop();
    } finally {
      setSmartglassesTransportForRuntime(null);
    }
  });

  it("honors Android EvenDemoApp F4 init mode during Eliza-managed startup", async () => {
    const transport = new MockSmartglassesTransport();
    setSmartglassesTransportForRuntime(transport);
    try {
      const service = await SmartglassesService.start({
        getSetting: (key: string) =>
          key === SMARTGLASSES_INIT_MODE_SETTING ? "android-f4" : undefined,
      } as never);
      expect(
        transport.writes.slice(-2).map((write) => Array.from(write.data)),
      ).toEqual([
        [G1Command.RightInit, 0x01],
        [G1Command.RightInit, 0x01],
      ]);
      await service.stop();
    } finally {
      setSmartglassesTransportForRuntime(null);
    }
  });

  it("sends broader G1 capability packets through the service", async () => {
    const transport = new MockSmartglassesTransport();
    const service = new SmartglassesService();
    service.setTransport(transport);

    await service.setBrightness(3, true);
    await service.setDashboard(true, 4);
    await service.setHeadUpAngle(20);
    await service.clearDisplay();
    await service.setSilentMode(true);
    await service.setGlassesWearDetection(false);
    await service.sendHeartbeat(3);
    await service.sendConnectionReady();
    await service.sendStartAi(0x17);
    await service.exitToDashboard();
    await service.exitFunction();
    await service.requestSerial("right");
    await service.sendAppWhitelist({ apps: ["eliza"] });
    await service.sendRaw(Uint8Array.from([0x4d, 0x01]), "left");
    await service.pageUp();
    await service.pageDown();
    await service.addOrUpdateNote(1, "Now", "Test");
    await service.deleteNote(1);
    await service.requestVoiceNoteAudio(1, { syncId: 2 });
    await service.deleteVoiceNoteAudio(1, { syncId: 3 });
    await service.sendNotification({
      appIdentifier: "eliza",
      title: "Hi",
      message: "From Eliza",
    });
    await service.sendBmpImage(Uint8Array.from([1, 2, 3]));
    await service.sendMonochromeBmpImage(Uint8Array.from([0, 255, 255, 0]), {
      width: 2,
      height: 2,
    });

    const commands = transport.writes.map((write) => write.data[0]);
    expect(commands).toContain(G1Command.Brightness);
    expect(commands).toContain(G1Command.DashboardPosition);
    expect(commands).toContain(G1Command.HeadUpAngle);
    expect(commands).toContain(G1Command.SilentMode);
    expect(commands).toContain(G1Command.GlassesWear);
    expect(commands).toContain(G1Command.Heartbeat);
    expect(commands).toContain(G1Command.Init);
    expect(commands).toContain(G1Command.RightInit);
    expect(commands).toContain(G1Command.StartAi);
    expect(commands).toContain(G1Command.ExitFunction);
    expect(commands).toContain(G1Command.GetSerial);
    expect(commands).toContain(G1Command.AppWhitelist);
    expect(commands).toContain(G1Command.Note);
    expect(commands).toContain(G1Command.Notification);
    expect(commands).toContain(G1Command.BmpData);
    expect(commands).toContain(G1Command.BmpCrc);
    expect(
      transport.writes.some(
        (write) =>
          write.data[0] === G1Command.BmpData &&
          write.data[6] === 0x42 &&
          write.data[7] === 0x4d,
      ),
    ).toBe(true);
    expect(
      transport.writes.some(
        (write) =>
          write.side === "left" &&
          write.data[0] === 0x4d &&
          write.data[1] === 0x01,
      ),
    ).toBe(true);
    expect(
      transport.writes.some(
        (write) =>
          write.side === "right" && write.data[0] === G1Command.GetSerial,
      ),
    ).toBe(true);
    expect(
      transport.writes.some(
        (write) =>
          write.side === "right" &&
          write.data[0] === G1Command.Note &&
          write.data[3] === 2 &&
          write.data[4] === 2,
      ),
    ).toBe(true);
    expect(
      transport.writes.some(
        (write) =>
          write.side === "right" &&
          write.data[0] === G1Command.Note &&
          write.data[3] === 3 &&
          write.data[4] === 4,
      ),
    ).toBe(true);
    expect(
      transport.writes.some(
        (write) =>
          write.side === "left" &&
          write.data[0] === G1Command.StartAi &&
          write.data[1] === 0x01,
      ),
    ).toBe(true);
    expect(
      transport.writes.some(
        (write) =>
          write.side === "right" &&
          write.data[0] === G1Command.StartAi &&
          write.data[1] === 0x01,
      ),
    ).toBe(true);
  });
});
