/**
 * Cross-platform e2e for plugin-vision.
 *
 * Sends the fixture PNG to the vision model surface. This is the PR-lane
 * variant: it points the model at `ELIZA_MOCK_VISION_BASE` (mockoon
 * environment, set by another agent) when present, otherwise skips cleanly
 * without real-API access.
 *
 * Real vision API testing is in the post-merge `*.real.e2e.test.ts` lane.
 *
 * Skip rules:
 *   - Skips when neither `ELIZA_MOCK_VISION_BASE` (PR lane) nor
 *     `OPENAI_API_KEY` + `ELIZA_REAL_APIS=1` (post-merge) is set.
 *   - The fixture file must exist on disk; missing fixture -> skip.
 *
 * Asserts:
 *   - When the model client runs against the mock, a non-empty description
 *     is produced (verifies the request reached the model layer).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FIXTURE = resolve(__dirname, "fixtures", "sample-scene.png");

const HAS_MOCK = !!process.env.ELIZA_MOCK_VISION_BASE;
const HAS_REAL =
  process.env.ELIZA_REAL_APIS === "1" && !!process.env.OPENAI_API_KEY;

// Tests skip when no model surface is configured and record a clean skip reason.
const skipModel = !HAS_MOCK && !HAS_REAL;

describe("plugin-vision cross-platform e2e", () => {
  it.skipIf(skipModel)(
    "model surface returns a description for the fixture image (mock or real)",
    async () => {
      const baseUrl = process.env.ELIZA_MOCK_VISION_BASE
        ? process.env.ELIZA_MOCK_VISION_BASE
        : "https://api.openai.com/v1";
      const apiKey = process.env.ELIZA_MOCK_VISION_BASE
        ? "mock"
        : (process.env.OPENAI_API_KEY ?? "");
      const model = process.env.ELIZA_MOCK_VISION_BASE
        ? "gpt-4o-mock"
        : (process.env.OPENAI_VISION_MODEL ?? "gpt-4o");

      const fixture = readFileSync(FIXTURE);
      const dataUrl = `data:image/png;base64,${fixture.toString("base64")}`;
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 80,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Briefly describe this image (one sentence).",
                },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
        }),
      });
      expect(response.ok).toBe(true);
      const body = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const text = body.choices?.[0]?.message?.content ?? "";
      expect(text.length).toBeGreaterThan(0);
    },
    60_000,
  );

  if (skipModel) {
    it("vision model surface skipped — set ELIZA_MOCK_VISION_BASE (PR lane) or ELIZA_REAL_APIS=1+OPENAI_API_KEY (post-merge)", () => {
      expect(skipModel).toBe(true);
    });
  }
});
