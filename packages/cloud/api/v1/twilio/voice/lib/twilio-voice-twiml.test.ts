/** Verifies the exact TwiML contract used for inbound public-line calls. */

import { describe, expect, test } from "bun:test";
import {
  buildRealtimeVoiceTwiML,
  buildTerminalVoiceTwiML,
  ELIZA_AI_CALL_DISCLOSURE,
} from "./twilio-voice-twiml";

describe("Twilio voice TwiML", () => {
  test("connects a bidirectional stream through its signed URL", () => {
    const xml = buildRealtimeVoiceTwiML({
      streamUrl: "wss://api.eliza.app/api/v1/twilio/voice/media",
      sessionId: "11111111-1111-4111-8111-111111111111",
      token: "signed",
      disclosure: ELIZA_AI_CALL_DISCLOSURE,
    });

    expect(xml).toContain(
      `<Response><Say>${ELIZA_AI_CALL_DISCLOSURE}</Say><Connect><Stream url="wss://api.eliza.app/`,
    );
    expect(xml).toContain(
      'name="sessionId" value="11111111-1111-4111-8111-111111111111"',
    );
    expect(xml).toContain('name="token" value="signed"');
  });

  test("escapes every caller-controlled XML field", () => {
    const xml = buildRealtimeVoiceTwiML({
      streamUrl: "wss://example.test/a?x=1&y=<bad>",
      sessionId: '"session"',
      token: "token'one",
      disclosure: "AI <assistant>",
    });

    expect(xml).not.toContain("<bad>");
    expect(xml).toContain("AI &lt;assistant&gt;");
    expect(xml).toContain("x=1&amp;y=&lt;bad&gt;");
    expect(xml).toContain("&quot;session&quot;");
    expect(xml).toContain("token&apos;one");
  });

  test("builds a terminal spoken response", () => {
    expect(buildTerminalVoiceTwiML("Not <ready>")).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Not &lt;ready&gt;</Say></Response>',
    );
  });
});
