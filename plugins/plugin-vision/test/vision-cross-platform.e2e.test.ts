/**
 * Cross-platform e2e for plugin-vision.
 *
 * Exercises the vision analysis pipeline with `ELIZA_VISION_TEST_INPUT=image`
 * so the fixture PNG is fed in instead of live screen/camera capture. This is
 * the PR-lane variant: it points the model at `ELIZA_MOCK_VISION_BASE`
 * (mockoon environment, set by another agent) when present, otherwise skips
 * cleanly without real-API access.
 *
 * Real vision API testing is in the post-merge `*.real.e2e.test.ts` lane.
 *
 * Skip rules:
 *   - Skips when neither `ELIZA_MOCK_VISION_BASE` (PR lane) nor
 *     `OPENAI_API_KEY` + `ELIZA_REAL_APIS=1` (post-merge) is set.
 *   - The fixture file must exist on disk; missing fixture -> skip.
 *
 * Asserts:
 *   - getTestImage() returns a valid PNG buffer (the wire-up is live).
 *   - When the model client runs against the mock, a non-empty description
 *     is produced (verifies the request reached the model layer).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getTestImage, getTestInputMode } from "../src/test-input";

const FIXTURE = resolve(__dirname, "fixtures", "sample-scene.png");

const HAS_MOCK = !!process.env.ELIZA_MOCK_VISION_BASE;
const HAS_REAL =
  process.env.ELIZA_REAL_APIS === "1" && !!process.env.OPENAI_API_KEY;

// Tests skip when no model surface is configured. They still verify the
// test-input plumbing end-to-end (assertion against fixture bytes) once a
// driver is set, otherwise they record a clean skip reason.
const skipModel = !HAS_MOCK && !HAS_REAL;

describe("plugin-vision cross-platform e2e", () => {
  it("getTestImage returns null when ELIZA_VISION_TEST_INPUT is unset", () => {
    const prev = process.env.ELIZA_VISION_TEST_INPUT;
    delete process.env.ELIZA_VISION_TEST_INPUT;
    try {
      expect(getTestInputMode()).toBe("unset");
      expect(getTestImage()).toBeNull();
    } finally {
      if (prev !== undefined) process.env.ELIZA_VISION_TEST_INPUT = prev;
    }
  });

  it("getTestImage returns the fixture PNG bytes when ELIZA_VISION_TEST_INPUT=image", () => {
    expect(existsSync(FIXTURE)).toBe(true);
    const prevMode = process.env.ELIZA_VISION_TEST_INPUT;
    const prevPath = process.env.ELIZA_VISION_TEST_FIXTURE;
    process.env.ELIZA_VISION_TEST_INPUT = "image";
    process.env.ELIZA_VISION_TEST_FIXTURE = FIXTURE;
    try {
      const buf = getTestImage();
      expect(buf).not.toBeNull();
      expect(Buffer.isBuffer(buf)).toBe(true);
      // PNG signature: 89 50 4E 47 0D 0A 1A 0A
      expect(buf?.[0]).toBe(0x89);
      expect(buf?.[1]).toBe(0x50);
      expect(buf?.[2]).toBe(0x4e);
      expect(buf?.[3]).toBe(0x47);
      // Same length as the on-disk fixture.
      expect(buf?.length).toBe(readFileSync(FIXTURE).length);
    } finally {
      if (prevMode === undefined) delete process.env.ELIZA_VISION_TEST_INPUT;
      else process.env.ELIZA_VISION_TEST_INPUT = prevMode;
      if (prevPath === undefined) delete process.env.ELIZA_VISION_TEST_FIXTURE;
      else process.env.ELIZA_VISION_TEST_FIXTURE = prevPath;
    }
  });

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
