import { describe, expect, it } from "vitest";
import { G1Command } from "../protocol.js";
import { EvenBridgeTransport } from "../transport/even-bridge.js";

describe("EvenBridgeTransport", () => {
  it("writes both lenses left first and waits before right", async () => {
    let resolveLeft: (() => void) | undefined;
    const writes: string[] = [];
    const transport = new EvenBridgeTransport({
      write: async (side) => {
        writes.push(`${side}:start`);
        if (side === "left") {
          await new Promise<void>((resolve) => {
            resolveLeft = resolve;
          });
        }
        writes.push(`${side}:done`);
      },
    });

    await transport.connect();
    const pending = transport.writeBoth(Uint8Array.from([G1Command.Heartbeat]));
    await Promise.resolve();

    expect(writes).toEqual(["left:start"]);
    resolveLeft?.();
    await pending;

    expect(writes).toEqual([
      "left:start",
      "left:done",
      "right:start",
      "right:done",
    ]);
  });

  it("uses bridge write/audioControl and forwards bridge events", async () => {
    let eventHandler: (event: unknown) => void = () => undefined;
    const writes: Array<{ side: string; data: number[] }> = [];
    const audioControls: boolean[] = [];
    let unsubscribed = false;
    const transport = new EvenBridgeTransport({
      write: async (side, data) =>
        writes.push({ side, data: Array.from(data) }),
      rawBridge: {
        audioControl: async (enabled) => audioControls.push(enabled),
      },
      onEvent: (handler) => {
        eventHandler = handler;
        return () => {
          unsubscribed = true;
        };
      },
    });
    const events: string[] = [];
    const audio: number[] = [];
    const encodings: string[] = [];

    transport.onEvent((event) => events.push(event.label ?? event.type));
    transport.onAudio((pcm, _sampleRate, _side, encoding) => {
      audio.push(...pcm);
      if (encoding) encodings.push(encoding);
    });

    await transport.connect();
    await transport.writeBoth(Uint8Array.from([G1Command.SendResult, 1]));
    await transport.openMicrophone(true);

    eventHandler({ side: "left", data: [0xf5, 0x00] });
    eventHandler({ audioEvent: { audioPcm: [1, 2, 3] } });

    expect(transport.isConnected()).toBe(true);
    expect(writes).toEqual([
      { side: "left", data: [G1Command.SendResult, 1] },
      { side: "right", data: [G1Command.SendResult, 1] },
    ]);
    expect(audioControls).toEqual([true]);
    expect(events).toContain("double_tap");
    expect(audio).toEqual([1, 2, 3]);
    expect(encodings).toEqual(["pcm16"]);

    await transport.disconnect();
    expect(audioControls).toEqual([true, false]);
    expect(unsubscribed).toBe(true);
  });

  it("supports object-shaped bridge event subscriptions", async () => {
    let removed = false;
    const transport = new EvenBridgeTransport({
      rawBridge: {
        audioControl: async () => undefined,
      },
      onEvenHubEvent: () => ({
        unsubscribe: () => {
          removed = true;
        },
      }),
    });

    await transport.connect();
    await transport.disconnect();

    expect(removed).toBe(true);
  });

  it("renders G1 display packets through the EvenHub simulator bridge surface", async () => {
    const pages: Array<Record<string, unknown>> = [];
    const transport = new EvenBridgeTransport({
      sendStartUpPage: (container) =>
        pages.push(container as Record<string, unknown>),
    });

    await transport.writeBoth(
      Uint8Array.from([
        G1Command.SendResult,
        0,
        1,
        0,
        0x40,
        0,
        0,
        1,
        1,
        ...new TextEncoder().encode("hello simulator"),
      ]),
    );

    expect(pages).toHaveLength(1);
    expect(pages[0].text).toBe("hello simulator");
    expect(pages[0].textObject).toHaveLength(1);
    expect(pages[0].listObject).toHaveLength(1);
  });

  it("uses official EvenHub startup and rebuild display methods", async () => {
    const created: Array<Record<string, unknown>> = [];
    const rebuilt: Array<Record<string, unknown>> = [];
    const transport = new EvenBridgeTransport({
      createStartUpPageContainer: (container) => {
        created.push(container);
        return 0;
      },
      rebuildPageContainer: (container) => {
        rebuilt.push(container);
        return true;
      },
    });

    await transport.writeBoth(
      Uint8Array.from([
        G1Command.SendResult,
        0,
        1,
        0,
        0x31,
        0,
        0,
        1,
        1,
        ...new TextEncoder().encode("first"),
      ]),
    );
    await transport.writeBoth(
      Uint8Array.from([
        G1Command.SendResult,
        1,
        1,
        0,
        0x40,
        0,
        0,
        1,
        1,
        ...new TextEncoder().encode("second"),
      ]),
    );

    expect(created.map((page) => page.text)).toEqual(["first"]);
    expect(rebuilt.map((page) => page.text)).toEqual(["second"]);
  });

  it("renders G1 display packets through the MentraOS displayText bridge surface", async () => {
    const displays: Array<Record<string, unknown>> = [];
    const clears: string[] = [];
    const transport = new EvenBridgeTransport({
      displayText: (params) => displays.push(params),
      clearDisplay: () => clears.push("clear"),
    });

    await transport.writeBoth(
      Uint8Array.from([
        G1Command.SendResult,
        0,
        2,
        0,
        0x31,
        0,
        0,
        1,
        1,
        ...new TextEncoder().encode("hello "),
      ]),
    );
    await transport.writeBoth(
      Uint8Array.from([
        G1Command.SendResult,
        0,
        2,
        1,
        0x31,
        0,
        0,
        1,
        1,
        ...new TextEncoder().encode("mentra"),
      ]),
    );
    await transport.write(
      "left",
      Uint8Array.from([G1Command.StartAi, 0x18, 0, 0, 0]),
    );

    expect(displays).toEqual([{ text: "hello mentra", x: 0, y: 0, size: 24 }]);
    expect(clears).toEqual(["clear"]);
  });

  it("uses MentraOS setMicState and forwards native PCM/LC3 mic events", async () => {
    let eventHandler: (event: unknown) => void = () => undefined;
    const micStates: Array<{
      sendPcmData: boolean;
      sendTranscript: boolean;
      bypassVad: boolean;
    }> = [];
    const transport = new EvenBridgeTransport({
      setMicState: async (sendPcmData, sendTranscript, bypassVad) =>
        micStates.push({ sendPcmData, sendTranscript, bypassVad }),
      onEvent: (handler) => {
        eventHandler = handler;
        return undefined;
      },
    });
    const audio: Array<{ bytes: number[]; encoding?: string }> = [];
    transport.onAudio((bytes, _sampleRate, _side, encoding) =>
      audio.push({ bytes: Array.from(bytes), encoding }),
    );

    await transport.connect();
    await transport.openMicrophone(true);
    await transport.openMicrophone(false);
    eventHandler({ type: "mic_pcm", pcm: Uint8Array.from([1, 2]).buffer });
    eventHandler({ type: "mic_lc3", lc3: Uint8Array.from([3, 4]) });

    expect(micStates).toEqual([
      { sendPcmData: true, sendTranscript: true, bypassVad: true },
      { sendPcmData: false, sendTranscript: false, bypassVad: false },
    ]);
    expect(audio).toEqual([
      { bytes: [1, 2], encoding: "pcm16" },
      { bytes: [3, 4], encoding: "lc3" },
    ]);
  });

  it("forwards MentraOS local transcription events", async () => {
    let eventHandler: (event: unknown) => void = () => undefined;
    const transport = new EvenBridgeTransport({
      onEvent: (handler) => {
        eventHandler = handler;
        return undefined;
      },
    });
    const transcripts: Array<{
      text: string;
      isFinal: boolean;
      language?: unknown;
    }> = [];
    transport.onTranscript((text, isFinal, metadata) =>
      transcripts.push({
        text,
        isFinal,
        language: metadata?.transcribeLanguage,
      }),
    );

    await transport.connect();
    eventHandler({
      type: "local_transcription",
      text: "hello glasses",
      isFinal: false,
      transcribeLanguage: "en-US",
    });
    eventHandler({
      streamType: "transcription:en-US",
      transcript: "final text",
      isFinal: true,
    });

    expect(transcripts).toEqual([
      { text: "hello glasses", isFinal: false, language: "en-US" },
      { text: "final text", isFinal: true, language: undefined },
    ]);
  });

  it("maps EvenHub simulator input events to tap labels", async () => {
    let eventHandler: (event: unknown) => void = () => undefined;
    const transport = new EvenBridgeTransport({
      onEvenHubEvent: (handler) => {
        eventHandler = handler;
        return undefined;
      },
    });
    const events: string[] = [];
    transport.onEvent((event) => events.push(event.label ?? event.type));

    await transport.connect();
    eventHandler({ listEvent: { eventType: 0 } });
    eventHandler({ textEvent: { eventType: 1 } });
    eventHandler({ textEvent: { event_type: "SCROLL_BOTTOM_EVENT" } });
    eventHandler({ textEvent: { event_type: "click" } });
    eventHandler({ eventType: "DOUBLE_CLICK_EVENT" });
    eventHandler({ jsonData: JSON.stringify({ event_type: "long_press" }) });
    eventHandler({ action: "up" });
    eventHandler({ sysEvent: {} });

    expect(events).toEqual([
      "single_tap",
      "scroll_up",
      "scroll_down",
      "single_tap",
      "double_tap",
      "long_press",
      "scroll_up",
      "single_tap",
    ]);
  });

  it("falls back to callEvenApp for sends and audio control", async () => {
    const calls: Array<{ name: string; payload?: Record<string, unknown> }> =
      [];
    const transport = new EvenBridgeTransport({
      rawBridge: {
        callEvenApp: async (name, payload) => calls.push({ name, payload }),
      },
    });

    await transport.write("right", Uint8Array.from([1, 2]));
    await transport.openMicrophone(true);

    expect(calls).toEqual([
      { name: "sendData", payload: { side: "right", data: [1, 2] } },
      { name: "audioControl", payload: { isOpen: true } },
    ]);
  });

  it("routes Wi-Fi scan, status, and credential setup through bridge APIs", async () => {
    const credentials: Array<{ ssid: string; password: string }> = [];
    const transport = new EvenBridgeTransport({
      requestWifiScan: () => ({
        status: "scan-complete",
        networks: [{ ssid: "Home" }, { SSID: "Office" }, "Guest"],
      }),
      requestWifiStatus: () => ({ connectedSsid: "Home" }),
      setWifiCredentials: (ssid, password) => {
        credentials.push({ ssid, password });
        return { message: "queued" };
      },
    });

    await expect(transport.scanWifi()).resolves.toMatchObject({
      available: true,
      status: "scan-complete",
      networks: ["Home", "Office", "Guest"],
    });
    await expect(transport.getWifiStatus()).resolves.toMatchObject({
      status: "Home",
    });
    await expect(
      transport.configureWifi("Home", "secret"),
    ).resolves.toMatchObject({
      status: "queued",
    });

    expect(credentials).toEqual([{ ssid: "Home", password: "secret" }]);
  });

  it("does not advertise Wi-Fi when a display-only bridge lacks Wi-Fi hooks", async () => {
    const transport = new EvenBridgeTransport({
      displayText: () => undefined,
    });

    expect(transport.supportsWifi()).toBe(false);
    await expect(transport.scanWifi()).rejects.toThrow(/Wi-Fi/);
  });
});
