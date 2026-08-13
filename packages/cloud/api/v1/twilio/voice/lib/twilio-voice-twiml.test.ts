/** Verifies the exact TwiML contract used for inbound and outbound calls. */

import { describe, expect, test } from "bun:test";
import {
  buildRealtimeVoiceTwiML,
  buildTerminalVoiceTwiML,
} from "./twilio-voice-twiml";

describe("Twilio voice TwiML", () => {
  test("connects a bidirectional stream with scoped call parameters", () => {
    const xml = buildRealtimeVoiceTwiML({
      streamUrl: "wss://api.elizacloud.ai/api/v1/twilio/voice/media",
      calledNumber: "+14484080429",
      conversationId: "f87a6f75-9fcf-4d74-8ef0-8feb2f8c8b25",
      greeting: "Hi, you're connected to Eliza.",
    });

    expect(xml).toContain("<Say>Hi, you&apos;re connected to Eliza.</Say>");
    expect(xml).toContain('<Connect><Stream url="wss://api.elizacloud.ai/');
    expect(xml).toContain('name="calledNumber" value="+14484080429"');
    expect(xml).toContain(
      'name="conversationId" value="f87a6f75-9fcf-4d74-8ef0-8feb2f8c8b25"',
    );
  });

  test("escapes every caller-controlled XML field", () => {
    const xml = buildRealtimeVoiceTwiML({
      streamUrl: "wss://example.test/a?x=1&y=<bad>",
      calledNumber: '"+1"',
      conversationId: "id'one",
      greeting: "A & B < C",
    });

    expect(xml).not.toContain("<bad>");
    expect(xml).toContain("x=1&amp;y=&lt;bad&gt;");
    expect(xml).toContain("&quot;+1&quot;");
    expect(xml).toContain("id&apos;one");
    expect(xml).toContain("A &amp; B &lt; C");
  });

  test("builds a terminal spoken response", () => {
    expect(buildTerminalVoiceTwiML("Not <ready>")).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Not &lt;ready&gt;</Say></Response>',
    );
  });
});
