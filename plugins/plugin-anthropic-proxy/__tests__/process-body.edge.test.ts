/**
 * Edge-case tests for `processBody`: billing/system/metadata insertion, trailing
 * assistant-prefill and thinking-block stripping, and malformed-body handling.
 * Pure string transforms, no network.
 */

import { describe, expect, it } from "vitest";
import { type ProcessBodyConfig, processBody } from "../src/proxy/process-body.js";

const baseConfig: ProcessBodyConfig = {
  replacements: [],
  toolRenames: [],
  propRenames: [],
  stripSystemConfig: false,
  stripToolDescriptions: false,
  injectCCSyntheticTools: false,
  deviceId: "device-test",
  sessionId: "session-test",
};

function parseProcessed(body: unknown, overrides: Partial<ProcessBodyConfig> = {}) {
  const result = processBody(JSON.stringify(body), {
    ...baseConfig,
    ...overrides,
  });
  return {
    ...result,
    parsed: JSON.parse(result.body) as Record<string, unknown>,
  };
}

describe("processBody edge handling", () => {
  it("injects system and metadata into an empty object without producing invalid JSON", () => {
    const { parsed } = parseProcessed({});

    expect(Array.isArray(parsed.system)).toBe(true);
    expect(parsed.metadata).toEqual({
      user_id: JSON.stringify({
        device_id: "device-test",
        session_id: "session-test",
      }),
    });
  });

  it("replaces existing metadata without truncating string values that contain braces", () => {
    const { parsed } = parseProcessed({
      metadata: {
        note: "keep literal } inside string",
        nested: { ok: true },
      },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(parsed.metadata).toEqual({
      user_id: JSON.stringify({
        device_id: "device-test",
        session_id: "session-test",
      }),
    });
    expect(parsed.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("strips trailing assistant prefill and thinking blocks while leaving user text intact", () => {
    const { parsed, stats } = parseProcessed({
      messages: [
        {
          role: "user",
          content: [
            { type: "thinking", text: "hidden chain" },
            { type: "text", text: "visible" },
            { type: "redacted_thinking", data: "hidden" },
          ],
        },
        { role: "assistant", content: "prefill" },
      ],
      thinking: { type: "enabled", budget_tokens: 1024 },
    });

    expect(stats.assistantPrefillStripped).toBe(1);
    expect(stats.thinkingBlocksStripped).toBe(2);
    expect(stats.thinkingParamsStripped).toBe(1);
    expect(parsed.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "visible" }],
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("hidden");
  });
});

// Regression: the thinking-parameter strip must never leave a dangling comma,
// regardless of the key's position. Production defaults keep the strip enabled,
// and a request that already carries a `system` array (prompt caching) plus
// `metadata` (user_id) leaves `thinking` as the first key, so neither the
// billing nor metadata injector prepends ahead of it. Before the fix, the
// first-key case produced `{,"system":...}` — malformed JSON rejected by
// api.anthropic.com (400 invalid JSON), silently breaking extended-thinking
// requests. See issue #29164.
describe("processBody thinking-parameter strip position invariance", () => {
  const prodDefaults: Partial<ProcessBodyConfig> = {
    stripSystemConfig: true,
    stripToolDescriptions: true,
    injectCCSyntheticTools: true,
    stripThinkingBlocks: true,
  };
  const thinking = { type: "enabled", budget_tokens: 2000 };

  const positions: Array<[string, Record<string, unknown>]> = [
    [
      "first key (system array + metadata already present)",
      {
        thinking,
        system: [{ type: "text", text: "sys" }],
        metadata: { user_id: "u" },
        model: "claude-opus-4-1",
        messages: [{ role: "user", content: "hi" }],
      },
    ],
    [
      "middle key",
      {
        model: "claude-opus-4-1",
        thinking,
        messages: [{ role: "user", content: "hi" }],
      },
    ],
    [
      "last key",
      {
        model: "claude-opus-4-1",
        messages: [{ role: "user", content: "hi" }],
        thinking,
      },
    ],
    ["sole key", { thinking }],
  ];

  for (const [label, body] of positions) {
    it(`produces valid JSON with the thinking param removed when it is the ${label}`, () => {
      const result = processBody(JSON.stringify(body), { ...baseConfig, ...prodDefaults });

      // Must be parseable — the first-key case throws before the fix.
      const parsed = JSON.parse(result.body) as Record<string, unknown>;
      expect("thinking" in parsed).toBe(false);
      expect(result.stats.thinkingParamsStripped).toBe(1);
      // No dangling separator anywhere in the rewritten body.
      expect(result.body).not.toContain("{,");
      expect(result.body).not.toContain(",,");
      expect(result.body).not.toContain(",}");
    });
  }
});

// The proxy forwards arbitrary client bodies, so the strip must survive raw
// wire shapes that `JSON.stringify` never emits: pretty-printed whitespace
// around the separator, a nested object inside the `thinking` value, and a `}`
// that lives inside a string. Each row is a raw request string, not a
// stringified object, and each must leave the whole pipeline output parseable
// with `thinking` removed. See PR #29167 review.
describe("processBody thinking-parameter strip raw-body shapes", () => {
  const prodDefaults: Partial<ProcessBodyConfig> = {
    stripSystemConfig: true,
    stripToolDescriptions: true,
    injectCCSyntheticTools: true,
    stripThinkingBlocks: true,
  };
  const messages = '"messages":[{"role":"user","content":"hi"}]';

  const rawBodies: Array<[string, string]> = [
    [
      "pretty-printed body with thinking as the last key",
      `{\n  "model": "x",\n  ${messages},\n  "thinking": {"type": "enabled", "budget_tokens": 2000}\n}`,
    ],
    [
      "a nested object inside the thinking value",
      `{"model":"x","thinking":{"type":"enabled","budget":{"tokens":5}},${messages}}`,
    ],
    [
      "a closing brace inside a string in the thinking value",
      `{"model":"x","thinking":{"type":"enab}led"},${messages}}`,
    ],
  ];

  for (const [label, raw] of rawBodies) {
    it(`produces valid JSON with the thinking param removed for ${label}`, () => {
      const result = processBody(raw, { ...baseConfig, ...prodDefaults });

      // Before the fix each of these throws: the last-key case leaves a
      // trailing comma, the nested and in-string cases stop removal early on
      // the wrong `}` and leave orphaned syntax.
      const parsed = JSON.parse(result.body) as Record<string, unknown>;
      expect("thinking" in parsed).toBe(false);
      expect(result.stats.thinkingParamsStripped).toBe(1);
      expect(result.body).not.toContain("{,");
      expect(result.body).not.toContain(",,");
      expect(result.body).not.toContain(",}");
    });
  }
});
