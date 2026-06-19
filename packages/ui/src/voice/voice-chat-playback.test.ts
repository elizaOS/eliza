import { describe, expect, it } from "vitest";
import { extractVoiceText } from "./voice-chat-playback";

describe("extractVoiceText", () => {
  it("extracts text from JSON assistant payloads", () => {
    expect(
      extractVoiceText('{"text":"Hello there.","actions":["REPLY"]}'),
    ).toBe("Hello there.");
  });

  it("suppresses structured action payloads without text", () => {
    expect(
      extractVoiceText('{"actions":["BENCHMARK_ACTION"],"params":{"foo":1}}'),
    ).toBe("");
  });
});
