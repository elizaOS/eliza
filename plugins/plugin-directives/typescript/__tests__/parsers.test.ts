import { describe, expect, it } from "bun:test";
import {
  extractElevatedDirective,
  extractExecDirective,
  extractModelDirective,
  extractReasoningDirective,
  extractStatusDirective,
  extractThinkDirective,
  extractVerboseDirective,
  normalizeElevatedLevel,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  normalizeVerboseLevel,
} from "../src/parsers";
import {
  applyDirectives,
  clearDirectiveState,
  getDirectiveState,
  parseDirectives,
} from "../src/index";

describe("Normalizers", () => {
  describe("normalizeThinkLevel", () => {
    it("normalizes off", () => {
      expect(normalizeThinkLevel("off")).toBe("off");
    });

    it("normalizes on to low", () => {
      expect(normalizeThinkLevel("on")).toBe("low");
      expect(normalizeThinkLevel("enable")).toBe("low");
    });

    it("normalizes minimal", () => {
      expect(normalizeThinkLevel("min")).toBe("minimal");
      expect(normalizeThinkLevel("minimal")).toBe("minimal");
    });

    it("normalizes medium", () => {
      expect(normalizeThinkLevel("med")).toBe("medium");
      expect(normalizeThinkLevel("medium")).toBe("medium");
      expect(normalizeThinkLevel("harder")).toBe("medium");
    });

    it("normalizes high", () => {
      expect(normalizeThinkLevel("high")).toBe("high");
      expect(normalizeThinkLevel("ultra")).toBe("high");
      expect(normalizeThinkLevel("max")).toBe("high");
    });

    it("normalizes xhigh", () => {
      expect(normalizeThinkLevel("xhigh")).toBe("xhigh");
      expect(normalizeThinkLevel("x-high")).toBe("xhigh");
    });

    it("returns undefined for invalid input", () => {
      expect(normalizeThinkLevel("invalid")).toBeUndefined();
      expect(normalizeThinkLevel(null)).toBeUndefined();
      expect(normalizeThinkLevel(undefined)).toBeUndefined();
    });
  });

  describe("normalizeVerboseLevel", () => {
    it("normalizes off", () => {
      expect(normalizeVerboseLevel("off")).toBe("off");
      expect(normalizeVerboseLevel("false")).toBe("off");
      expect(normalizeVerboseLevel("no")).toBe("off");
    });

    it("normalizes on", () => {
      expect(normalizeVerboseLevel("on")).toBe("on");
      expect(normalizeVerboseLevel("true")).toBe("on");
      expect(normalizeVerboseLevel("yes")).toBe("on");
    });

    it("normalizes full", () => {
      expect(normalizeVerboseLevel("full")).toBe("full");
      expect(normalizeVerboseLevel("all")).toBe("full");
    });
  });

  describe("normalizeReasoningLevel", () => {
    it("normalizes off", () => {
      expect(normalizeReasoningLevel("off")).toBe("off");
      expect(normalizeReasoningLevel("hide")).toBe("off");
    });

    it("normalizes on", () => {
      expect(normalizeReasoningLevel("on")).toBe("on");
      expect(normalizeReasoningLevel("show")).toBe("on");
    });

    it("normalizes stream", () => {
      expect(normalizeReasoningLevel("stream")).toBe("stream");
      expect(normalizeReasoningLevel("streaming")).toBe("stream");
      expect(normalizeReasoningLevel("live")).toBe("stream");
    });
  });

  describe("normalizeElevatedLevel", () => {
    it("normalizes off", () => {
      expect(normalizeElevatedLevel("off")).toBe("off");
      expect(normalizeElevatedLevel("false")).toBe("off");
    });

    it("normalizes on", () => {
      expect(normalizeElevatedLevel("on")).toBe("on");
      expect(normalizeElevatedLevel("true")).toBe("on");
    });

    it("normalizes ask", () => {
      expect(normalizeElevatedLevel("ask")).toBe("ask");
      expect(normalizeElevatedLevel("prompt")).toBe("ask");
    });

    it("normalizes full", () => {
      expect(normalizeElevatedLevel("full")).toBe("full");
      expect(normalizeElevatedLevel("auto")).toBe("full");
    });
  });

});

describe("Directive Extractors", () => {
  describe("extractThinkDirective", () => {
    it("extracts /think:high", () => {
      const result = extractThinkDirective("/think:high hello");
      expect(result.hasDirective).toBe(true);
      expect(result.thinkLevel).toBe("high");
      expect(result.cleaned).toBe("hello");
    });

    it("extracts /t medium", () => {
      const result = extractThinkDirective("/t medium world");
      expect(result.hasDirective).toBe(true);
      expect(result.thinkLevel).toBe("medium");
      expect(result.cleaned).toBe("world");
    });

    it("extracts /thinking without level", () => {
      const result = extractThinkDirective("/thinking test");
      expect(result.hasDirective).toBe(true);
      expect(result.thinkLevel).toBeUndefined();
      expect(result.cleaned).toBe("test");
    });

    it("handles empty input", () => {
      const result = extractThinkDirective("");
      expect(result.hasDirective).toBe(false);
      expect(result.cleaned).toBe("");
    });

    it("handles no directive", () => {
      const result = extractThinkDirective("hello world");
      expect(result.hasDirective).toBe(false);
      expect(result.cleaned).toBe("hello world");
    });
  });

  describe("extractVerboseDirective", () => {
    it("extracts /verbose:on", () => {
      const result = extractVerboseDirective("/verbose:on test");
      expect(result.hasDirective).toBe(true);
      expect(result.verboseLevel).toBe("on");
      expect(result.cleaned).toBe("test");
    });

    it("extracts /v full", () => {
      const result = extractVerboseDirective("/v full message");
      expect(result.hasDirective).toBe(true);
      expect(result.verboseLevel).toBe("full");
      expect(result.cleaned).toBe("message");
    });
  });

  describe("extractReasoningDirective", () => {
    it("extracts /reasoning:stream", () => {
      const result = extractReasoningDirective("/reasoning:stream test");
      expect(result.hasDirective).toBe(true);
      expect(result.reasoningLevel).toBe("stream");
      expect(result.cleaned).toBe("test");
    });

    it("extracts /reason on", () => {
      const result = extractReasoningDirective("/reason on hello");
      expect(result.hasDirective).toBe(true);
      expect(result.reasoningLevel).toBe("on");
    });
  });

  describe("extractElevatedDirective", () => {
    it("extracts /elevated:full", () => {
      const result = extractElevatedDirective("/elevated:full test");
      expect(result.hasDirective).toBe(true);
      expect(result.elevatedLevel).toBe("full");
      expect(result.cleaned).toBe("test");
    });

    it("extracts /elev ask", () => {
      const result = extractElevatedDirective("/elev ask hello");
      expect(result.hasDirective).toBe(true);
      expect(result.elevatedLevel).toBe("ask");
    });
  });

  describe("extractStatusDirective", () => {
    it("extracts /status", () => {
      const result = extractStatusDirective("/status hello");
      expect(result.hasDirective).toBe(true);
      expect(result.cleaned).toBe("hello");
    });

    it("handles no status directive", () => {
      const result = extractStatusDirective("just text");
      expect(result.hasDirective).toBe(false);
      expect(result.cleaned).toBe("just text");
    });
  });

  describe("extractModelDirective", () => {
    it("extracts /model provider/model", () => {
      const result = extractModelDirective("/model anthropic/claude-3-opus test");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("anthropic/claude-3-opus");
      expect(result.cleaned).toBe("test");
    });

    it("extracts /model with auth profile", () => {
      const result = extractModelDirective("/model openai/gpt-5@myprofile query");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("openai/gpt-5");
      expect(result.rawProfile).toBe("myprofile");
      expect(result.cleaned).toBe("query");
    });

    it("extracts /model without value", () => {
      const result = extractModelDirective("/model");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBeUndefined();
    });

    it("handles model aliases", () => {
      const result = extractModelDirective("/claude test", { aliases: ["claude", "gpt"] });
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("claude");
      expect(result.cleaned).toBe("test");
    });
  });

  describe("extractExecDirective", () => {
    it("extracts /exec with options", () => {
      const result = extractExecDirective("/exec host=gateway security=allowlist test");
      expect(result.hasDirective).toBe(true);
      expect(result.execHost).toBe("gateway");
      expect(result.execSecurity).toBe("allowlist");
      expect(result.hasExecOptions).toBe(true);
    });

    it("extracts /exec without options", () => {
      const result = extractExecDirective("/exec test");
      expect(result.hasDirective).toBe(true);
      expect(result.hasExecOptions).toBe(false);
    });

    it("marks invalid options", () => {
      const result = extractExecDirective("/exec host=invalid security=bad");
      expect(result.hasDirective).toBe(true);
      expect(result.invalidHost).toBe(true);
      expect(result.invalidSecurity).toBe(true);
    });
  });

});

describe("parseDirectives", () => {
  it("parses multiple directives", () => {
    const result = parseDirectives("/think:high /v on /elevated ask hello world");
    expect(result.hasThinkDirective).toBe(true);
    expect(result.thinkLevel).toBe("high");
    expect(result.hasVerboseDirective).toBe(true);
    expect(result.verboseLevel).toBe("on");
    expect(result.hasElevatedDirective).toBe(true);
    expect(result.elevatedLevel).toBe("ask");
    expect(result.cleanedText).toBe("hello world");
  });

  it("detects directive-only messages", () => {
    const result = parseDirectives("/think:high /verbose on");
    expect(result.directivesOnly).toBe(true);
    expect(result.cleanedText).toBe("");
  });

  it("handles message with no directives", () => {
    const result = parseDirectives("just a normal message");
    expect(result.directivesOnly).toBe(false);
    expect(result.cleanedText).toBe("just a normal message");
    expect(result.hasThinkDirective).toBe(false);
    expect(result.hasVerboseDirective).toBe(false);
  });

  it("respects disableElevated option", () => {
    const result = parseDirectives("/elevated on test", { disableElevated: true });
    expect(result.hasElevatedDirective).toBe(false);
    expect(result.cleanedText).toBe("/elevated on test");
  });
});

describe("Session State Management", () => {
  const roomId = "test-room-state";

  beforeEach(() => {
    clearDirectiveState(roomId);
  });

  it("applies directives to session state", () => {
    const directives = parseDirectives("/think:high /verbose on");
    applyDirectives(roomId, directives);

    const state = getDirectiveState(roomId);
    expect(state.thinking).toBe("high");
    expect(state.verbose).toBe("on");
  });

  it("preserves existing state when applying new directives", () => {
    const directives1 = parseDirectives("/think:high");
    applyDirectives(roomId, directives1);

    const directives2 = parseDirectives("/verbose full");
    applyDirectives(roomId, directives2);

    const state = getDirectiveState(roomId);
    expect(state.thinking).toBe("high"); // preserved
    expect(state.verbose).toBe("full"); // updated
  });

  it("returns default state for unknown room", () => {
    const state = getDirectiveState("unknown-room");
    expect(state.thinking).toBe("low");
    expect(state.verbose).toBe("off");
    expect(state.elevated).toBe("off");
  });

  it("clears state correctly", () => {
    const directives = parseDirectives("/think:high");
    applyDirectives(roomId, directives);

    clearDirectiveState(roomId);

    const state = getDirectiveState(roomId);
    expect(state.thinking).toBe("low"); // back to default
  });

  it("applies model directive to state", () => {
    const directives = parseDirectives("/model anthropic/claude-3@profile1");
    applyDirectives(roomId, directives);

    const state = getDirectiveState(roomId);
    expect(state.model.provider).toBe("anthropic");
    expect(state.model.model).toBe("claude-3");
    expect(state.model.authProfile).toBe("profile1");
  });

});
