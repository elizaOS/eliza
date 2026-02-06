import { describe, expect, it, beforeEach } from "bun:test";
import {
  getTtsText,
  hasTtsDirective,
  parseTtsDirective,
  stripTtsDirectives,
} from "../src/directive-parser";
import { cleanTextForTts, truncateText } from "../src/text-processor";
import {
  clearTtsConfig,
  getTtsConfig,
  setTtsConfig,
  shouldApplyTts,
} from "../src/index";
import { DEFAULT_TTS_CONFIG } from "../src/types";

describe("TTS Directive Parser", () => {
  describe("hasTtsDirective", () => {
    it("detects [[tts]] directive", () => {
      expect(hasTtsDirective("Hello [[tts]] world")).toBe(true);
    });

    it("detects [[tts:...]] directive", () => {
      expect(hasTtsDirective("[[tts:provider=elevenlabs]] Hello")).toBe(true);
    });

    it("detects [[tts:text]] blocks", () => {
      expect(hasTtsDirective("[[tts:text]]Hello[[/tts:text]]")).toBe(true);
    });

    it("returns false for plain text", () => {
      expect(hasTtsDirective("No directive here")).toBe(false);
    });

    it("returns false for similar but invalid patterns", () => {
      expect(hasTtsDirective("[[not-tts]]")).toBe(false);
      expect(hasTtsDirective("[tts]")).toBe(false);
    });
  });

  describe("parseTtsDirective", () => {
    it("returns null for text without directives", () => {
      expect(parseTtsDirective("Plain text")).toBeNull();
    });

    it("parses simple [[tts]] directive", () => {
      const directive = parseTtsDirective("[[tts]] Hello");
      expect(directive).not.toBeNull();
    });

    it("parses provider option", () => {
      const directive = parseTtsDirective("[[tts:provider=elevenlabs]]");
      expect(directive?.provider).toBe("elevenlabs");
    });

    it("parses voice option", () => {
      const directive = parseTtsDirective("[[tts:voice=alloy]]");
      expect(directive?.voice).toBe("alloy");
    });

    it("parses speed option", () => {
      const directive = parseTtsDirective("[[tts:speed=1.5]]");
      expect(directive?.speed).toBe(1.5);
    });

    it("parses multiple options", () => {
      const directive = parseTtsDirective(
        "[[tts:provider=openai voice=nova speed=1.2]]"
      );
      expect(directive?.provider).toBe("openai");
      expect(directive?.voice).toBe("nova");
      expect(directive?.speed).toBe(1.2);
    });

    it("parses text block", () => {
      const directive = parseTtsDirective(
        "Before [[tts:text]]Custom TTS text[[/tts:text]] after"
      );
      expect(directive?.text).toBe("Custom TTS text");
    });

    it("normalizes provider names", () => {
      expect(parseTtsDirective("[[tts:provider=eleven]]")?.provider).toBe("elevenlabs");
      expect(parseTtsDirective("[[tts:provider=oai]]")?.provider).toBe("openai");
      expect(parseTtsDirective("[[tts:provider=microsoft]]")?.provider).toBe("edge");
      expect(parseTtsDirective("[[tts:provider=sam]]")?.provider).toBe("simple-voice");
    });
  });

  describe("stripTtsDirectives", () => {
    it("strips [[tts]] directive", () => {
      expect(stripTtsDirectives("Hello [[tts]] world")).toBe("Hello world");
    });

    it("strips [[tts:...]] directive", () => {
      expect(stripTtsDirectives("[[tts:provider=elevenlabs]] Hello")).toBe("Hello");
    });

    it("strips [[tts:text]] blocks", () => {
      expect(
        stripTtsDirectives("Before [[tts:text]]TTS text[[/tts:text]] after")
      ).toBe("Before after");
    });

    it("strips multiple directives", () => {
      expect(
        stripTtsDirectives("[[tts]] Hello [[tts:voice=alloy]] world")
      ).toBe("Hello world");
    });
  });

  describe("getTtsText", () => {
    it("returns directive text if present", () => {
      const text = "Message [[tts:text]]Custom[[/tts:text]]";
      const directive = parseTtsDirective(text);
      expect(getTtsText(text, directive)).toBe("Custom");
    });

    it("returns cleaned text if no directive text", () => {
      const text = "[[tts]] Message";
      const directive = parseTtsDirective(text);
      expect(getTtsText(text, directive)).toBe("Message");
    });

    it("returns original text if no directive", () => {
      expect(getTtsText("Plain message", null)).toBe("Plain message");
    });
  });
});

describe("Text Processor", () => {
  describe("cleanTextForTts", () => {
    it("removes code blocks", () => {
      const text = "Hello\n```js\ncode\n```\nworld";
      expect(cleanTextForTts(text)).toBe("Hello\n[code block]\nworld");
    });

    it("removes inline code", () => {
      expect(cleanTextForTts("Use `const` here")).toBe("Use [code] here");
    });

    it("removes URLs", () => {
      expect(cleanTextForTts("Visit https://example.com now")).toBe("Visit [link] now");
    });

    it("removes markdown bold", () => {
      expect(cleanTextForTts("This is **bold** text")).toBe("This is bold text");
    });

    it("removes markdown italic", () => {
      expect(cleanTextForTts("This is *italic* text")).toBe("This is italic text");
    });

    it("removes markdown headers", () => {
      expect(cleanTextForTts("# Header\nText")).toBe("Header\nText");
    });

    it("removes markdown links", () => {
      expect(cleanTextForTts("[click here](https://example.com)")).toBe("click here");
    });

    it("removes HTML tags", () => {
      expect(cleanTextForTts("<b>bold</b> text")).toBe("bold text");
    });
  });

  describe("truncateText", () => {
    it("returns original if under limit", () => {
      expect(truncateText("Short text", 100)).toBe("Short text");
    });

    it("truncates at sentence boundary", () => {
      const text = "First sentence. Second sentence. Third sentence.";
      const truncated = truncateText(text, 30);
      expect(truncated).toBe("First sentence.");
    });

    it("adds ellipsis when truncating mid-sentence", () => {
      const text = "This is a very long sentence without any breaks";
      const truncated = truncateText(text, 20);
      expect(truncated.endsWith("...")).toBe(true);
      expect(truncated.length).toBeLessThanOrEqual(23); // +3 for "..."
    });

    it("truncates at word boundary", () => {
      const text = "Word1 Word2 Word3 Word4 Word5";
      const truncated = truncateText(text, 15);
      expect(truncated).not.toContain("Word3");
    });
  });
});

describe("TTS Config", () => {
  const roomId = "test-room-config";

  beforeEach(() => {
    clearTtsConfig(roomId);
  });

  describe("getTtsConfig", () => {
    it("returns default config for new room", () => {
      const config = getTtsConfig(roomId);
      expect(config.auto).toBe(DEFAULT_TTS_CONFIG.auto);
      expect(config.provider).toBe(DEFAULT_TTS_CONFIG.provider);
    });

    it("returns merged config for room with overrides", () => {
      setTtsConfig(roomId, { auto: "always" });
      const config = getTtsConfig(roomId);
      expect(config.auto).toBe("always");
      expect(config.provider).toBe(DEFAULT_TTS_CONFIG.provider); // default preserved
    });
  });

  describe("setTtsConfig", () => {
    it("sets config values", () => {
      setTtsConfig(roomId, { auto: "inbound", provider: "edge" });
      const config = getTtsConfig(roomId);
      expect(config.auto).toBe("inbound");
      expect(config.provider).toBe("edge");
    });

    it("merges with existing config", () => {
      setTtsConfig(roomId, { auto: "always" });
      setTtsConfig(roomId, { provider: "openai" });
      const config = getTtsConfig(roomId);
      expect(config.auto).toBe("always"); // preserved
      expect(config.provider).toBe("openai"); // updated
    });
  });

  describe("clearTtsConfig", () => {
    it("clears config for room", () => {
      setTtsConfig(roomId, { auto: "always" });
      clearTtsConfig(roomId);
      const config = getTtsConfig(roomId);
      expect(config.auto).toBe(DEFAULT_TTS_CONFIG.auto); // back to default
    });
  });
});

describe("shouldApplyTts", () => {
  it("returns false when auto is off", () => {
    expect(shouldApplyTts({ ...DEFAULT_TTS_CONFIG, auto: "off" }, {})).toBe(false);
  });

  it("returns true when auto is always", () => {
    expect(shouldApplyTts({ ...DEFAULT_TTS_CONFIG, auto: "always" }, {})).toBe(true);
  });

  it("respects inbound mode", () => {
    const config = { ...DEFAULT_TTS_CONFIG, auto: "inbound" as const };
    expect(shouldApplyTts(config, {})).toBe(false);
    expect(shouldApplyTts(config, { inboundAudio: false })).toBe(false);
    expect(shouldApplyTts(config, { inboundAudio: true })).toBe(true);
  });

  it("respects tagged mode", () => {
    const config = { ...DEFAULT_TTS_CONFIG, auto: "tagged" as const };
    expect(shouldApplyTts(config, {})).toBe(false);
    expect(shouldApplyTts(config, { hasDirective: false })).toBe(false);
    expect(shouldApplyTts(config, { hasDirective: true })).toBe(true);
  });
});
