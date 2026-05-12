import { describe, expect, it } from "vitest";
import {
  coerceEmotion,
  DEFAULT_EMOTION,
  EMOTIONS,
  emotionFromText,
  emotionToOmnivoiceKeyword,
} from "../emotion";

describe("emotion taxonomy", () => {
  it("EMOTIONS lists the seven canonical labels", () => {
    expect([...EMOTIONS]).toEqual([
      "neutral",
      "happy",
      "sad",
      "angry",
      "surprised",
      "fearful",
      "disgusted",
    ]);
  });

  it("coerceEmotion accepts canonical names, ignores case", () => {
    expect(coerceEmotion("Happy")).toBe("happy");
    expect(coerceEmotion("ANGRY")).toBe("angry");
    expect(coerceEmotion("neutral")).toBe("neutral");
  });

  it("coerceEmotion maps synonyms", () => {
    expect(coerceEmotion("joyful")).toBe("happy");
    expect(coerceEmotion("scared")).toBe("fearful");
    expect(coerceEmotion("furious")).toBe("angry");
    expect(coerceEmotion("calm")).toBe("neutral");
  });

  it("coerceEmotion falls back to default for unknown input", () => {
    expect(coerceEmotion("zorgon")).toBe(DEFAULT_EMOTION);
    expect(coerceEmotion(undefined)).toBe(DEFAULT_EMOTION);
    expect(coerceEmotion(42)).toBe(DEFAULT_EMOTION);
    expect(coerceEmotion("")).toBe(DEFAULT_EMOTION);
  });

  it("emotionFromText fires on keyword hits", () => {
    expect(emotionFromText("yay this is awesome")).toBe("happy");
    expect(emotionFromText("I'm so sorry I made you cry")).toBe("sad");
    expect(emotionFromText("wow really? omg")).toBe("surprised");
    expect(emotionFromText("gross, yuck")).toBe("disgusted");
  });

  it("emotionFromText defaults to neutral for plain text", () => {
    expect(emotionFromText("the meeting is at 3pm")).toBe(DEFAULT_EMOTION);
    expect(emotionFromText("")).toBe(DEFAULT_EMOTION);
  });

  it("emotionToOmnivoiceKeyword skips neutral, passes through others", () => {
    expect(emotionToOmnivoiceKeyword("neutral")).toBeUndefined();
    expect(emotionToOmnivoiceKeyword("happy")).toBe("happy");
    expect(emotionToOmnivoiceKeyword("disgusted")).toBe("disgusted");
  });
});
