import { expect, test } from "bun:test";
import {
  encodeTextPackets,
  formatDisplayLines,
  G1_DISPLAY,
  G1AiStatus,
  G1Command,
  G1ScreenAction,
  measureG1DisplayText,
  microphoneActionForInteractionEvent,
  paginateDisplayText,
  parseG1Notification,
} from "../../../plugins/plugin-hearwear/src/protocol/smartglasses.js";

test("G1 display text wraps by measured display width and packet payload limit", () => {
  const lines = formatDisplayLines(
    [
      "latin text that should wrap cleanly without overflowing the OLED field",
      "界".repeat(42),
      "Привет ".repeat(16),
    ].join("\n"),
  );

  expect(lines.length).toBeGreaterThan(3);
  expect(
    lines.every(
      (line) => measureG1DisplayText(line) <= G1_DISPLAY.displayWidthPx,
    ),
  ).toBe(true);

  const [page] = paginateDisplayText("界".repeat(80));
  const packets = encodeTextPackets(
    {
      ...page,
      screenStatus: G1AiStatus.Displaying | G1ScreenAction.NewContent,
    },
    9,
  );
  const decoded = packets
    .map((packet) => new TextDecoder().decode(packet.slice(9)))
    .join("");

  expect(packets.length).toBeGreaterThan(1);
  expect(
    packets.every(
      (packet) => packet.byteLength - 9 <= G1_DISPLAY.maxPayloadBytes,
    ),
  ).toBe(true);
  expect(Array.from(packets[0].slice(0, 5))).toEqual([
    G1Command.SendResult,
    9,
    packets.length,
    0,
    G1AiStatus.Displaying | G1ScreenAction.NewContent,
  ]);
  expect(decoded).not.toContain("�");
  expect(decoded.replaceAll("\n", "")).toBe("界".repeat(80));
});

test("G1 interaction events map side taps to microphone actions", () => {
  expect(
    microphoneActionForInteractionEvent(
      parseG1Notification("right", Uint8Array.from([G1Command.StartAi, 0x01])),
    ),
  ).toBe("enable");
  expect(
    microphoneActionForInteractionEvent(
      parseG1Notification("right", Uint8Array.from([G1Command.StartAi, 0x17])),
    ),
  ).toBe("enable");
  expect(
    microphoneActionForInteractionEvent(
      parseG1Notification("right", Uint8Array.from([G1Command.StartAi, 0x00])),
    ),
  ).toBe("disable");
  expect(
    microphoneActionForInteractionEvent(
      parseG1Notification("right", Uint8Array.from([G1Command.StartAi, 0x18])),
    ),
  ).toBe("disable");
});

test("G1 microphone data exposes right-lens LC3 sequence and payload", () => {
  expect(
    parseG1Notification(
      "right",
      Uint8Array.from([G1Command.ReceiveMicData, 7, 1, 2, 3, 4]),
    ),
  ).toMatchObject({
    side: "right",
    type: "mic-data",
    sequence: 7,
    audioEncoding: "lc3",
    label: "mic_data",
    audioData: Uint8Array.from([1, 2, 3, 4]),
  });
});
