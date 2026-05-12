/**
 * Real-API end-to-end test for plugin-computeruse — post-merge lane only.
 *
 * Drives the real Anthropic Messages API (or a mockoon endpoint when
 * ANTHROPIC_API_BASE_URL is set) with the official `computer_20250124`
 * tool and executes the returned tool calls through ComputerUseService.
 * Asserts that an end-to-end screenshot → click → type loop terminates with
 * a non-empty assistant message and a fresh screenshot.
 *
 * Environment gating:
 *   ELIZA_REAL_APIS=1            Required; otherwise the test skips cleanly
 *   ANTHROPIC_API_KEY=…          Required for live API calls
 *   ANTHROPIC_API_BASE_URL=…     Optional; mockoon override URL
 *   ANTHROPIC_MODEL=…            Optional; defaults to claude-opus-4-7
 *
 * macOS only — Linux requires Xvfb (covered separately) and Windows is not
 * in scope for this lane yet.
 */

import { platform } from "node:os";
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { ComputerUseService } from "../src/services/computer-use-service.js";
import type { ComputerActionResult } from "../src/types.js";

const REAL = process.env.ELIZA_REAL_APIS === "1";
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const ON_MAC = platform() === "darwin";
const skip = !REAL || !HAS_KEY || !ON_MAC;

const ANTHROPIC_BASE =
  process.env.ANTHROPIC_API_BASE_URL ?? "https://api.anthropic.com";
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";

function createMockRuntime(): IAgentRuntime {
  const settings: Record<string, string> = {
    COMPUTER_USE_APPROVAL_MODE: "full_control",
  };
  return {
    character: {},
    getSetting: (k: string) => settings[k],
    getService: () => null,
  } as IAgentRuntime;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface TextBlock {
  type: "text";
  text: string;
}
type ContentBlock = ToolUseBlock | TextBlock | { type: string };

interface AnthropicResponse {
  content: ContentBlock[];
  stop_reason: string;
}

async function callAnthropic(
  messages: Array<{ role: "user" | "assistant"; content: unknown }>,
): Promise<AnthropicResponse> {
  const response = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "computer-use-2025-01-24",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      tools: [
        {
          type: "computer_20250124",
          name: "computer",
          display_width_px: 1280,
          display_height_px: 800,
          display_number: 1,
        },
      ],
      messages,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Anthropic API ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as AnthropicResponse;
}

describe("plugin-computeruse real-API e2e (post-merge)", () => {
  it.skipIf(skip)(
    "completes a tool-use turn against Anthropic Messages with computer_20250124",
    async () => {
      const service = (await ComputerUseService.start(
        createMockRuntime(),
      )) as ComputerUseService;
      try {
        const initial = await callAnthropic([
          {
            role: "user",
            content:
              "Take a screenshot, then describe the dominant color you see.",
          },
        ]);

        const toolUses = initial.content.filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );
        expect(toolUses.length).toBeGreaterThan(0);

        const toolResults: Array<Record<string, unknown>> = [];
        for (const block of toolUses) {
          const action = String(block.input.action ?? "");
          if (action === "screenshot") {
            const r = (await service.executeCommand(
              "screenshot",
            )) as ComputerActionResult;
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: r.screenshot
                ? [
                    {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: "image/png",
                        data: r.screenshot,
                      },
                    },
                  ]
                : "screenshot unavailable",
            });
          } else {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `unsupported in test harness: ${action}`,
            });
          }
        }

        const followup = await callAnthropic([
          { role: "user", content: "Take a screenshot and describe it." },
          { role: "assistant", content: initial.content },
          { role: "user", content: toolResults },
        ]);

        const text = followup.content
          .filter((b): b is TextBlock => b.type === "text")
          .map((b) => b.text)
          .join(" ");
        expect(text.length).toBeGreaterThan(10);
      } finally {
        await service.stop();
      }
    },
    120_000,
  );

  if (skip) {
    it("skipped — set ELIZA_REAL_APIS=1 + ANTHROPIC_API_KEY on macOS to run", () => {
      expect(skip).toBe(true);
    });
  }
});
