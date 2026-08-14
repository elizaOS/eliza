/** Verifies the exact TwiML contract used for inbound public-line calls. */

import { describe, expect, test } from "bun:test";
import {
  buildRealtimeVoiceTwiML,
  buildTerminalVoiceTwiML,
} from "./twilio-voice-twiml";

describe("Twilio voice TwiML", () => {
  test("connects a bidirectional stream through its signed URL", () => {
    const xml = buildRealtimeVoiceTwiML({
      streamUrl: "wss://api.eliza.app/api/v1/twilio/voice/media?token=signed",
      greeting: "Hi, you're connected to Eliza.",
    });

    expect(xml).toContain("<Say>Hi, you&apos;re connected to Eliza.</Say>");
    expect(xml).toContain('<Connect><Stream url="wss://api.eliza.app/');
    expect(xml).toContain("?token=signed");
    expect(xml).not.toContain("<Parameter");
  });

  test("escapes every caller-controlled XML field", () => {
    const xml = buildRealtimeVoiceTwiML({
      streamUrl: "wss://example.test/a?x=1&y=<bad>",
      greeting: "A & B < C",
    });

    expect(xml).not.toContain("<bad>");
    expect(xml).toContain("x=1&amp;y=&lt;bad&gt;");
    expect(xml).toContain("A &amp; B &lt; C");
  });

  test("builds a terminal spoken response", () => {
    expect(buildTerminalVoiceTwiML("Not <ready>")).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Not &lt;ready&gt;</Say></Response>',
    );
  });
});
