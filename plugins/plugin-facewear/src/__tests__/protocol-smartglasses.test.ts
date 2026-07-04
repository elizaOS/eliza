/**
 * Smartglasses protocol tests pin Even Realities G1 command encoders and parser
 * behavior at the byte level.
 */
import { describe, expect, it } from "vitest";
import {
  encodeAppWhitelist,
  encodeBatteryStatusRequest,
  encodeBmpTransfer,
  encodeBrightness,
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
  encodeNoteAdd,
  encodeNoteDelete,
  encodeNotification,
  encodeSilentMode,
  encodeTextPacket,
  encodeTextPackets,
  encodeTranslateLanguages,
  encodeTranslateSetup,
  encodeTranslateStart,
  encodeTranslateText,
  encodeVoiceNoteDelete,
  encodeVoiceNoteDeleteAll,
  encodeVoiceNoteFetch,
  encodeVoiceNoteList,
  formatDisplayLines,
  G1AiStatus,
  G1Command,
  G1DashboardLayout,
  G1ScreenAction,
  G1TemperatureUnit,
  G1TextStatus,
  G1TimeFormat,
  measureG1DisplayText,
  paginateDisplayText,
  parseG1Notification,
  pcm16ToFloat32,
} from "../protocol/smartglasses.ts";

describe("Even G1 protocol", () => {
  it("wraps text into centered five-line display pages", () => {
    const pages = paginateDisplayText(
      "one two three four five six seven eight nine ten",
      {
        charsPerLine: 9,
        linesPerPage: 3,
      },
    );

    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({
      pageNumber: 1,
      maxPages: 2,
      screenStatus: G1AiStatus.Displaying | G1ScreenAction.NewContent,
    });
    expect(pages[1].screenStatus).toBe(G1AiStatus.DisplayComplete);
  });

  it("wraps default display text by measured G1 pixel width", () => {
    const wideLines = formatDisplayLines("m".repeat(40));
    const cjkLines = formatDisplayLines("界".repeat(40));

    expect(wideLines).toHaveLength(2);
    expect(cjkLines).toHaveLength(2);
    expect(
      [...wideLines, ...cjkLines].every(
        (line) => measureG1DisplayText(line) <= 576,
      ),
    ).toBe(true);
  });

  it("keeps explicit character wrapping available for compatibility tests", () => {
    expect(formatDisplayLines("one two three", 7)).toEqual([
      "one two",
      "three",
    ]);
  });

  it("encodes display packets with the 0x4E send-result header", () => {
    const [page] = paginateDisplayText("hello");
    const packet = encodeTextPacket(page, 7);
    const body = new TextDecoder().decode(packet.slice(9));

    expect(Array.from(packet.slice(0, 9))).toEqual([
      G1Command.SendResult,
      7,
      1,
      0,
      G1AiStatus.DisplayComplete,
      0,
      0,
      1,
      1,
    ]);
    expect(body).toContain("hello");
  });

  it("supports direct Text Show display status from the native protocol", () => {
    const [page] = paginateDisplayText("direct text");
    const packet = encodeTextPacket(
      {
        ...page,
        screenStatus: G1TextStatus.TextShow | G1ScreenAction.NewContent,
      },
      8,
    );

    expect(packet[4]).toBe(0x71);
  });

  it("chunks display payloads over the official 191-byte packet limit", () => {
    const [page] = paginateDisplayText("界".repeat(80));
    const packets = encodeTextPackets(page, 9);
    const decoder = new TextDecoder();
    const byteLength = packets.reduce(
      (total, packet) => total + packet.byteLength - 9,
      0,
    );
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const packet of packets) {
      bytes.set(packet.slice(9), offset);
      offset += packet.byteLength - 9;
    }
    const text = decoder.decode(bytes);

    expect(packets).toHaveLength(2);
    expect(Array.from(packets[0].slice(0, 4))).toEqual([
      G1Command.SendResult,
      9,
      2,
      0,
    ]);
    expect(Array.from(packets[1].slice(0, 4))).toEqual([
      G1Command.SendResult,
      9,
      2,
      1,
    ]);
    expect(Array.from(packets[0].slice(5, 7))).toEqual([0, 0]);
    const secondPacketOffset = packets[0].byteLength - 9;
    expect(Array.from(packets[1].slice(5, 7))).toEqual([
      secondPacketOffset >>> 8,
      secondPacketOffset & 0xff,
    ]);
    const packetTexts = packets.map((packet) =>
      decoder.decode(packet.slice(9)),
    );
    expect(packets.every((packet) => packet.byteLength - 9 <= 191)).toBe(true);
    expect(packetTexts.every((packetText) => !packetText.includes("�"))).toBe(
      true,
    );
    expect(text).not.toContain("�");
    expect(text.replaceAll("\n", "")).toBe("界".repeat(80));
    expect(() => encodeTextPacket(page, 9)).toThrow(/encodeTextPackets/);
  });

  it("encodes microphone enable and disable packets", () => {
    expect(Array.from(encodeMicCommand(true))).toEqual([G1Command.OpenMic, 1]);
    expect(Array.from(encodeMicCommand(false))).toEqual([G1Command.OpenMic, 0]);
  });

  it("encodes heartbeat packets with 8-bit sequence wrapping", () => {
    expect(Array.from(encodeHeartbeat(2))).toEqual([
      G1Command.Heartbeat,
      0x06,
      0x00,
      2,
      0x04,
      2,
    ]);
    expect(Array.from(encodeHeartbeat(255))).toEqual([
      G1Command.Heartbeat,
      0x06,
      0x00,
      255,
      0x04,
      255,
    ]);
    expect(Array.from(encodeHeartbeat(256))).toEqual([
      G1Command.Heartbeat,
      0x06,
      0x00,
      0,
      0x04,
      0,
    ]);
    expect(Array.from(encodeBatteryStatusRequest())).toEqual([
      G1Command.Battery,
      0x01,
    ]);
  });

  it("encodes lens-specific connection-ready init packets", () => {
    expect(Array.from(encodeConnectionReady("left"))).toEqual([
      G1Command.Init,
      0x01,
    ]);
    expect(Array.from(encodeConnectionReady("right"))).toEqual([
      G1Command.RightInit,
      0x01,
    ]);
  });

  it("encodes official EvenDemoApp connection-ready init packets", () => {
    expect(Array.from(encodeConnectionReady("left", "official"))).toEqual([
      G1Command.Init,
      0x01,
    ]);
    expect(Array.from(encodeConnectionReady("right", "official"))).toEqual([
      G1Command.Init,
      0x01,
    ]);
  });

  it("encodes Android EvenDemoApp F4 connection-ready init packets", () => {
    expect(Array.from(encodeConnectionReady("left", "android-f4"))).toEqual([
      G1Command.RightInit,
      0x01,
    ]);
    expect(Array.from(encodeConnectionReady("right", "android-f4"))).toEqual([
      G1Command.RightInit,
      0x01,
    ]);
  });

  it("encodes native low-level control packets from the official app", () => {
    expect(Array.from(encodeExitFunction())).toEqual([G1Command.ExitFunction]);
    expect(Array.from(encodeGetSerial())).toEqual([G1Command.GetSerial]);

    const packets = encodeAppWhitelist({ apps: ["eliza"] });
    expect(packets).toHaveLength(1);
    expect(Array.from(packets[0].slice(0, 3))).toEqual([
      G1Command.AppWhitelist,
      1,
      0,
    ]);
    expect(new TextDecoder().decode(packets[0].slice(3))).toBe(
      '{"apps":["eliza"]}',
    );
  });

  it("parses microphone response status separately from requested mic state", () => {
    expect(
      parseG1Notification("right", Uint8Array.from([0x0e, 0xc9, 0x01])),
    ).toMatchObject({
      type: "mic-response",
      micEnabled: true,
      micRequested: true,
      responseOk: true,
      responseStatus: 0xc9,
      label: "mic_enabled",
    });

    expect(
      parseG1Notification("right", Uint8Array.from([0x0e, 0xca, 0x01])),
    ).toMatchObject({
      type: "mic-response",
      micEnabled: false,
      micRequested: true,
      responseOk: false,
      responseStatus: 0xca,
      label: "mic_failed",
    });
  });

  it("encodes G1 settings, dashboard, notes, and notifications", () => {
    expect(Array.from(encodeSilentMode(true))).toEqual([
      G1Command.SilentMode,
      0x0c,
      0x00,
    ]);
    expect(Array.from(encodeBrightness(0x10, true))).toEqual([
      G1Command.Brightness,
      0x10,
      0x01,
    ]);
    expect(Array.from(encodeDashboard(true, 8))).toEqual([
      G1Command.DashboardPosition,
      0x07,
      0x00,
      0x01,
      0x02,
      0x01,
      0x08,
    ]);
    expect(Array.from(encodeDashboardPosition(3, 7, 0x42))).toEqual([
      G1Command.DashboardPosition,
      0x08,
      0x00,
      0x42,
      0x02,
      0x01,
      0x03,
      0x07,
    ]);
    expect(Array.from(encodeHeadUpAngle(30))).toEqual([
      G1Command.HeadUpAngle,
      30,
      1,
    ]);
    expect(Array.from(encodeGlassesWear(false))).toEqual([
      G1Command.GlassesWear,
      0,
    ]);

    const note = encodeNoteAdd(2, "A", "B", 1_700_000_000_000);
    expect(note[0]).toBe(G1Command.Note);
    expect(note.includes(2)).toBe(true);
    expect(Array.from(encodeNoteDelete(2)).slice(0, 4)).toEqual([
      G1Command.Note,
      0x10,
      0x00,
      0xe0,
    ]);
    expect(Array.from(encodeVoiceNoteFetch(1, 2))).toEqual([
      G1Command.Note,
      0x06,
      0x00,
      0x02,
      0x02,
      0x01,
    ]);
    expect(Array.from(encodeVoiceNoteList(7))).toEqual([
      G1Command.Note,
      0x06,
      0x00,
      0x07,
      0x01,
      0x00,
    ]);
    expect(Array.from(encodeVoiceNoteDelete(1, 2))).toEqual([
      G1Command.Note,
      0x06,
      0x00,
      0x02,
      0x04,
      0x01,
    ]);
    expect(Array.from(encodeVoiceNoteDeleteAll(8))).toEqual([
      G1Command.Note,
      0x06,
      0x00,
      0x08,
      0x05,
      0x00,
    ]);

    const [notification] = encodeNotification({
      msgId: 7,
      appIdentifier: "eliza",
      title: "Title",
      message: "Message",
    });
    expect(notification[0]).toBe(G1Command.Notification);
    expect(notification[1]).toBe(7);
    expect(notification[2]).toBeGreaterThanOrEqual(1);
    expect(notification[3]).toBe(0);
  });

  it("encodes dashboard content, navigation, setup, and translation packets", () => {
    expect(Array.from(encodeDashboardLayout(G1DashboardLayout.Dual))).toEqual([
      G1Command.DashboardContent,
      0x07,
      0x00,
      0x1e,
      0x06,
      0x01,
      0x00,
    ]);

    expect(
      Array.from(
        encodeDashboardCalendarItem({
          name: "Test G1",
          time: "13:30-14:30",
          location: "Home",
        }),
      ),
    ).toEqual([
      0x06, 0x29, 0x00, 0x6d, 0x03, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x03,
      0x01, 0x01, 0x07, 0x54, 0x65, 0x73, 0x74, 0x20, 0x47, 0x31, 0x02, 0x0b,
      0x31, 0x33, 0x3a, 0x33, 0x30, 0x2d, 0x31, 0x34, 0x3a, 0x33, 0x30, 0x03,
      0x04, 0x48, 0x6f, 0x6d, 0x65,
    ]);

    expect(
      Array.from(
        encodeDashboardTimeWeather({
          seqId: 9,
          timestampMs: 1_700_000_000_000,
          timezoneOffsetSeconds: 0,
          weatherIcon: 0x10,
          temperatureInCelsius: 21,
          temperatureUnit: G1TemperatureUnit.Fahrenheit,
          timeFormat: G1TimeFormat.TwelveHour,
        }),
      ).slice(0, 5),
    ).toEqual([G1Command.DashboardContent, 0x15, 0x00, 9, 0x01]);

    expect(
      Array.from(encodeG1Setup({ calendar_enable: true })[0].slice(0, 3)),
    ).toEqual([G1Command.AppWhitelist, 1, 0]);
    expect(Array.from(encodeNavigationInit(7))).toEqual([
      G1Command.Navigation,
      0x06,
      0x00,
      7,
      0x00,
      0x01,
    ]);
    expect(
      Array.from(
        encodeNavigationDirections({
          seqId: 8,
          totalDuration: "4 min",
          totalDistance: "1 km",
          direction: "Main St",
          distance: "200 m",
          speed: "30",
          directionTurn: 0x03,
        }).slice(0, 10),
      ),
    ).toEqual([G1Command.Navigation, 0x26, 0x00, 8, 0x01, 0x03, 0, 0, 0, 0]);
    expect(Array.from(encodeNavigationPoller(9, 2))).toEqual([
      G1Command.Navigation,
      0x06,
      0x00,
      9,
      0x04,
      2,
    ]);
    expect(Array.from(encodeNavigationEnd(10))).toEqual([
      G1Command.Navigation,
      0x06,
      0x00,
      10,
      0x05,
      1,
    ]);
    expect(
      encodeNavigationPrimaryImage(
        Array.from({ length: 136 * 136 }, () => 0),
        Array.from({ length: 136 * 136 }, () => 0),
        0,
      )[0][0],
    ).toBe(G1Command.Navigation);

    expect(Array.from(encodeTranslateSetup())).toEqual([
      0x39, 0x05, 0x00, 0x00, 0x13,
    ]);
    expect(Array.from(encodeTranslateStart())).toEqual([
      0x50, 0x06, 0x00, 0x00, 0x01, 0x01,
    ]);
    expect(Array.from(encodeTranslateLanguages(0x02, 0x05))).toEqual([
      0x1c, 0x00, 0x02, 0x05,
    ]);
    expect(Array.from(encodeTranslateText("translated", "bonjour", 3))).toEqual(
      [0x0d, 3, 1, 0, 0, 0, 0x20, 0x0d, 98, 111, 110, 106, 111, 117, 114],
    );
  });

  it("encodes BMP transfer packets with data, end, and CRC commands", () => {
    const packets = encodeBmpTransfer(Uint8Array.from([1, 2, 3]));
    expect(Array.from(packets[0].slice(0, 6))).toEqual([
      G1Command.BmpData,
      0,
      0,
      0x1c,
      0,
      0,
    ]);
    expect(Array.from(packets.at(-2) ?? [])).toEqual([
      G1Command.BmpEnd,
      0x0d,
      0x0e,
    ]);
    expect(packets.at(-1)?.[0]).toBe(G1Command.BmpCrc);
  });

  it("builds 1-bit BMP bytes for the native G1 image path", () => {
    const bmp = encodeG1MonochromeBmp(Uint8Array.from([0, 255, 255, 0]), {
      width: 2,
      height: 2,
    });
    const view = new DataView(bmp.buffer);

    expect(new TextDecoder().decode(bmp.slice(0, 2))).toBe("BM");
    expect(view.getUint32(2, true)).toBe(bmp.length);
    expect(view.getUint32(10, true)).toBe(62);
    expect(view.getInt32(18, true)).toBe(2);
    expect(view.getInt32(22, true)).toBe(2);
    expect(view.getUint16(28, true)).toBe(1);
    expect(Array.from(bmp.slice(54, 62))).toEqual([
      0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00,
    ]);
    expect(Array.from(bmp.slice(62))).toEqual([
      0x80, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
    ]);
  });

  it("parses tap and microphone audio notifications", () => {
    const tap = parseG1Notification("left", Uint8Array.from([0xf5, 0x00]));
    expect(tap).toMatchObject({
      type: "state",
      label: "double_tap",
      stateCategory: "interaction",
    });
    expect(
      parseG1Notification("left", Uint8Array.from([0xf5, 0x17])),
    ).toMatchObject({
      type: "state",
      code: 0x17,
      label: "long_press",
      stateCategory: "interaction",
    });
    expect(
      parseG1Notification("left", Uint8Array.from([0xf5, 0x18])),
    ).toMatchObject({
      type: "state",
      code: 0x18,
      label: "stop_ai_recording",
      stateCategory: "interaction",
    });

    const audio = parseG1Notification(
      "right",
      Uint8Array.from([0xf1, 9, 0, 0, 255, 127]),
    );
    expect(audio).toMatchObject({ type: "mic-data", sequence: 9 });
    expect(audio.audioEncoding).toBe("lc3");
    expect(Array.from(audio.audioData ?? [])).toEqual([0, 0, 255, 127]);
    expect(audio.audioPcm).toBeUndefined();
  });

  it("classifies physical, battery, and device state notifications", () => {
    expect(
      parseG1Notification("left", Uint8Array.from([0xf5, 0x06])),
    ).toMatchObject({
      type: "state",
      label: "wearing",
      stateCategory: "physical",
      stateName: "wearing",
    });
    expect(
      parseG1Notification("left", Uint8Array.from([0xf5, 0x0e])),
    ).toMatchObject({
      type: "state",
      label: "cradle_charging_cable_changed",
      stateCategory: "battery",
      stateName: "cradle_charging_cable_changed",
    });
    expect(
      parseG1Notification("right", Uint8Array.from([0xf5, 0x11])),
    ).toMatchObject({
      type: "state",
      label: "connected",
      stateCategory: "device",
      stateName: "connected",
    });
  });

  it("parses dashboard, serial, and error event categories", () => {
    const dashboard = parseG1Notification(
      "left",
      Uint8Array.from([0x22, 0x02, 0, 0, 0, 0, 0, 0, 0]),
    );
    expect(dashboard).toMatchObject({
      type: "dashboard",
      code: 0x02,
      label: "dashboard_0x02",
    });

    const serial = parseG1Notification(
      "right",
      Uint8Array.from([
        G1Command.GetSerial,
        0xc9,
        ...new TextEncoder().encode("G1RIGHTSERIAL001"),
        0,
      ]),
    );
    expect(serial).toMatchObject({
      type: "serial",
      code: 0xc9,
      responseOk: true,
      serialNumber: "G1RIGHTSERIAL001",
      label: "serial_number",
    });

    const error = parseG1Notification("right", Uint8Array.from([0x04, 0x07]));
    expect(error).toMatchObject({
      type: "error",
      code: 0x07,
      label: "error_0x07",
    });
  });

  it("parses incoming init, display result, and notification chunks", () => {
    expect(
      parseG1Notification("left", Uint8Array.from([G1Command.Init, 0x01])),
    ).toMatchObject({
      type: "init",
      code: 0x01,
      label: "init",
    });
    expect(
      parseG1Notification(
        "right",
        Uint8Array.from([G1Command.RightInit, 0x01]),
      ),
    ).toMatchObject({
      type: "init",
      code: 0x01,
      label: "right_init",
    });

    const display = parseG1Notification(
      "left",
      Uint8Array.from([
        G1Command.SendResult,
        7,
        2,
        1,
        G1AiStatus.Displaying,
        0,
        191,
        3,
        5,
        ...new TextEncoder().encode("hello"),
      ]),
    );
    expect(display).toMatchObject({
      type: "display-result",
      displaySeq: 7,
      totalPackages: 2,
      currentPackage: 1,
      screenStatus: G1AiStatus.Displaying,
      charPosition: 191,
      pageNumber: 3,
      maxPages: 5,
      text: "hello",
      label: "display_result",
    });

    const notification = parseG1Notification(
      "right",
      Uint8Array.from([
        G1Command.Notification,
        4,
        2,
        0,
        ...new TextEncoder().encode('{"title":"Hi"}'),
      ]),
    );
    expect(notification).toMatchObject({
      type: "notification",
      notificationId: 4,
      totalPackages: 2,
      currentPackage: 0,
      text: '{"title":"Hi"}',
      label: "notification",
    });
    expect(new TextDecoder().decode(notification.notificationChunk)).toBe(
      '{"title":"Hi"}',
    );
  });

  it("parses voice note list and audio notifications", () => {
    const list = parseG1Notification(
      "right",
      Uint8Array.from([
        0x21, 0x2a, 0x00, 0x07, 0x01, 0x04, 0x01, 0x9a, 0xa1, 0x7a, 0x67, 0x77,
        0x0a, 0x84, 0xbb, 0x02, 0x23, 0xa2, 0x7a, 0x67, 0xa9, 0x73, 0x5a, 0xa5,
        0x03, 0x18, 0xa3, 0x7a, 0x67, 0xf1, 0x8f, 0x9e, 0x2c, 0x04, 0x7a, 0xa3,
        0x7a, 0x67, 0xde, 0xef, 0x2a, 0x85,
      ]),
    );
    expect(list).toMatchObject({
      type: "voice-note-list",
      syncId: 7,
      subcommand: 1,
      label: "voice_note_list",
    });
    expect(list.voiceNotes).toEqual([
      { index: 1, timestamp: 1736090010, crc: 3145992823 },
      { index: 2, timestamp: 1736090147, crc: 2774168489 },
      { index: 3, timestamp: 1736090392, crc: 748589041 },
      { index: 4, timestamp: 1736090490, crc: 2234183646 },
    ]);

    const audio = parseG1Notification(
      "right",
      Uint8Array.from([
        0x1e, 0x0e, 0x00, 0x09, 0x02, 0x03, 0x00, 0x01, 0x00, 0x02, 0xaa, 0xbb,
      ]),
    );
    expect(audio).toMatchObject({
      type: "voice-note-audio",
      syncId: 9,
      subcommand: 2,
      totalPackets: 3,
      currentPacket: 1,
      noteIndex: 1,
      sequence: 1,
      audioEncoding: "lc3",
      label: "voice_note_audio",
    });
    expect(Array.from(audio.audioData ?? [])).toEqual([0xaa, 0xbb]);
  });

  it("parses MentraOS G1 battery status responses", () => {
    expect(
      parseG1Notification(
        "left",
        Uint8Array.from([G1Command.Battery, 0x66, 87, 0x02, 0x9c, 0x0f]),
      ),
    ).toMatchObject({
      type: "battery-status",
      responseOk: true,
      batteryPercent: 87,
      batteryFlags: 0x02,
      batteryVoltageMv: 399.6,
      label: "battery_status",
    });

    expect(
      parseG1Notification("right", Uint8Array.from([G1Command.Battery, 0x00])),
    ).toMatchObject({
      type: "battery-status",
      responseOk: false,
      responseStatus: 0x00,
      label: "battery_status_invalid",
    });
  });

  it("converts little-endian PCM16 audio to float samples", () => {
    const pcm = pcm16ToFloat32(Uint8Array.from([0, 0, 0, 64, 0, 128]));
    expect(Array.from(pcm)).toEqual([0, 0.5, -1]);
  });
});
