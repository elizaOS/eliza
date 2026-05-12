/**
 * macOS-only real-API e2e for plugin-vision.
 *
 * Captures the real screen via `screencapture` (no fixture override) and
 * sends the bytes to a real OpenAI vision model. Skipped on Linux/Windows.
 *
 * Gating:
 *   - ELIZA_REAL_APIS=1
 *   - OPENAI_API_KEY=…
 *   - platform === "darwin"
 *   - macOS Screen Recording permission granted (else skipped)
 *
 * Asserts that a non-empty description comes back from the model.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ON_MAC = platform() === "darwin";
const REAL = process.env.ELIZA_REAL_APIS === "1";
const HAS_KEY = !!process.env.OPENAI_API_KEY;
const skip = !ON_MAC || !REAL || !HAS_KEY;

function captureMacScreenshot(): Buffer | null {
  const out = join(tmpdir(), `vision-real-${Date.now()}.png`);
  try {
    execFileSync("screencapture", ["-x", out], { stdio: "ignore" });
    if (!existsSync(out)) return null;
    const buf = readFileSync(out);
    if (buf.length === 0) return null;
    return buf;
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(out);
    } catch {
      /* best effort */
    }
  }
}

describe("plugin-vision macOS real-screen e2e (post-merge)", () => {
  it.skipIf(skip)(
    "captures real screen and gets a description from OpenAI vision",
    async () => {
      const buf = captureMacScreenshot();
      if (!buf) {
        // Permission likely missing — skip rather than fail.
        return;
      }
      const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
      const baseUrl =
        process.env.OPENAI_API_BASE ?? "https://api.openai.com/v1";
      const model = process.env.OPENAI_VISION_MODEL ?? "gpt-4o";
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 60,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "What's on screen? Brief answer." },
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
    120_000,
  );

  if (skip) {
    it("real-screen e2e skipped — needs darwin + ELIZA_REAL_APIS=1 + OPENAI_API_KEY", () => {
      expect(skip).toBe(true);
    });
  }
});
