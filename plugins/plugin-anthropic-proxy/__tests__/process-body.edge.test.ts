import { describe, expect, it } from "vitest";
import {
  type ProcessBodyConfig,
  processBody,
} from "../src/proxy/process-body.js";

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

function parseProcessed(
  body: unknown,
  overrides: Partial<ProcessBodyConfig> = {},
) {
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
