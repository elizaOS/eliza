/**
 * Live vision-qa test against the REAL Anthropic vision model — the only place
 * the model's actual cognition (not our client plumbing) is exercised. Gated:
 * runs only with a real ANTHROPIC_API_KEY AND (ANTHROPIC_LIVE_TEST=1 or
 * TEST_LANE=post-merge), so the PR lane self-skips honestly; registered in
 * packages/scripts/lib/real-live-suites.mjs so the post-merge accounting names
 * it instead of a silent green. Renders a fixture screenshot with known content
 * (an orange "Send" button beside a blank panel) via sharp, asks three
 * questions in one request, and asserts the structured answers land with the
 * right content and real token-usage provenance.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { askAboutImage } from "./ask.ts";
import type { VisionQuestion } from "./types.ts";

const LIVE =
  (process.env.ANTHROPIC_LIVE_TEST === "1" ||
    process.env.TEST_LANE === "post-merge") &&
  !!process.env.ANTHROPIC_API_KEY?.trim();

const liveDescribe = LIVE ? describe : describe.skip;

let dir: string;
let imagePath: string;

/**
 * Compose a 1000x600 screenshot: a neutral canvas, an orange rounded button
 * bearing the word "Send" on the left, and an empty bordered panel on the
 * right. Built from raw SVG so the text is real, crisp, and OCR/VLM-legible.
 */
async function renderFixture(target: string): Promise<void> {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600">
      <rect width="1000" height="600" fill="#f4f4f5"/>
      <rect x="80" y="250" width="220" height="90" rx="14" fill="#f0781e"/>
      <text x="190" y="308" font-family="Arial, sans-serif" font-size="40"
            font-weight="700" fill="#ffffff" text-anchor="middle">Send</text>
      <rect x="560" y="120" width="360" height="360" rx="12"
            fill="#ffffff" stroke="#d4d4d8" stroke-width="2"/>
    </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(target);
}

beforeAll(async () => {
  if (!LIVE) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-qa-live-"));
  imagePath = path.join(dir, "send-button.png");
  await renderFixture(imagePath);
});

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

liveDescribe("vision-qa live — real Anthropic vision model", () => {
  it("answers three questions about a rendered screenshot with usage provenance", async () => {
    const questions: VisionQuestion[] = [
      { id: "label", question: "What word is written on the button?" },
      { id: "color", question: "What color is the button?" },
      {
        id: "panel",
        question: "Is the large panel on the right side of the image empty?",
        expected: "yes",
      },
    ];
    const result = await askAboutImage(imagePath, questions, {
      backend: "anthropic",
      cacheDir: dir,
      noCache: true,
    });

    // Print the real trajectory for the PR evidence (questions + answers + usage).
    const trajectory = {
      model: result.provenance.model,
      usage: result.provenance.usage,
      latencyMs: result.provenance.latencyMs,
      retries: result.provenance.retries,
      dimensions: result.provenance.dimensions,
      answers: result.answers,
    };
    // The printed trajectory IS the PR evidence for this live suite.
    console.log(
      `[vision-qa.live] trajectory:\n${JSON.stringify(trajectory, null, 2)}`,
    );

    expect(result.answers).toHaveLength(3);
    const byId = new Map(result.answers.map((a) => [a.id, a]));

    const label = byId.get("label");
    expect(`${label?.answer} ${label?.details}`.toLowerCase()).toContain(
      "send",
    );

    const color = byId.get("color");
    expect(`${color?.answer} ${color?.details}`.toLowerCase()).toMatch(
      /orange/,
    );

    const panel = byId.get("panel");
    expect(panel?.answer.toLowerCase()).toMatch(/yes|empty|blank/);

    expect(result.provenance.usage.inputTokens).toBeGreaterThan(0);
    expect(result.provenance.usage.outputTokens).toBeGreaterThan(0);
  }, 60_000);
});
