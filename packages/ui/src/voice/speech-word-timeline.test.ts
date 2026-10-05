import { describe, expect, it } from "vitest";
import { createSpeechWordTimeline } from "./speech-word-timeline.js";

const timing = (text: string, offset = 0) => ({
  characters: [...text],
  characterStartTimesSeconds: [...text].map((_, i) => offset + i / 10),
  characterEndTimesSeconds: [...text].map((_, i) => offset + (i + 1) / 10),
});
describe("utterance-relative speech word timeline", () => {
  it("assembles split words without adding an offset to later frames", () => {
    const t = createSpeechWordTimeline("Hello world");
    t.append(timing("Hel"));
    t.append(timing("lo wor", 0.3));
    expect(t.at(0.2)).toEqual({ from: 0, to: 5, start: 0, end: 0.5 });
    expect(t.at(0.7)).toBeNull();
    t.append(timing("ld", 0.9));
    t.finish();
    expect(t.at(0.7)).toEqual({ from: 6, to: 11, start: 0.6, end: 1.1 });
    expect(t.at(0.55)).toBeNull();
    expect(t.at(2)).toBeNull();
    expect(t.at(0.1)?.from).toBe(0);
  });
  it("uses UTF-16 caption offsets and preserves whitespace", () => {
    const t = createSpeechWordTimeline("Hi 👋\nall");
    t.append(timing("Hi 👋\nall"));
    t.finish();
    expect(t.at(0.35)).toMatchObject({ from: 3, to: 5 });
    expect(t.at(0.65)).toMatchObject({ from: 6, to: 9 });
  });
  it("invalidates instead of guessing reset frame timestamps", () => {
    const t = createSpeechWordTimeline("One two");
    t.append(timing("One "));
    expect(t.at(0.1)).not.toBeNull();
    t.append(timing("two"));
    t.finish();
    expect(t.valid).toBe(false);
    expect(t.at(0.1)).toBeNull();
  });
  it("rejects missing, mismatched and incomplete text", () => {
    for (const input of [null, timing("Other"), timing("One")]) {
      const t = createSpeechWordTimeline("One two");
      t.append(input);
      t.finish();
      expect(t.valid).toBe(false);
      expect(t.at(0.1)).toBeNull();
    }
  });
  it("rejects malformed timing and mutation after completion", () => {
    for (const ends of [[NaN], [Infinity], [-1], [], [4000]]) {
      const t = createSpeechWordTimeline("A");
      t.append({ ...timing("A"), characterEndTimesSeconds: ends });
      expect(t.valid).toBe(false);
    }
    const t = createSpeechWordTimeline("A");
    t.append(timing("A"));
    t.finish();
    t.finish();
    expect(t.at(0.05)).not.toBeNull();
    t.append(timing("A"));
    expect(t.valid).toBe(false);
  });
  it("does not highlight invalid clocks or let returned ranges mutate state", () => {
    const t = createSpeechWordTimeline("A");
    t.append(timing("A"));
    t.finish();
    const range = t.at(0.05);
    if (range) range.from = 100;
    expect(t.at(0.05)?.from).toBe(0);
    for (const time of [NaN, Infinity, -1, 0.1]) expect(t.at(time)).toBeNull();
  });
});
