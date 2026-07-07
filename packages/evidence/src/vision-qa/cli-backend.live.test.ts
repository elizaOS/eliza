/**
 * Live test of the coding-agent CLI vision backend against a real `claude` or
 * `codex` CLI. This is the only place the CLI actually views a screenshot and
 * the full askAboutImage pipeline (stage image, spawn CLI, parse strict JSON, real
 * usage provenance) runs end to end. Gated behind ELIZA_VISION_QA_CLI_LIVE=1
 * (deliberate opt-in: it spends real tokens through the operator's authed CLI);
 * registered in packages/scripts/lib/real-live-suites.mjs so the post-merge
 * accounting names it instead of a silent green. ELIZA_VISION_QA_CLI selects
 * claude (default) or codex. Renders a solid-red fixture via sharp and asserts
 * the model reports red with real token-usage provenance.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { askAboutImage } from "./ask.ts";

const LIVE = process.env.ELIZA_VISION_QA_CLI_LIVE === "1";
const liveDescribe = LIVE ? describe : describe.skip;

let dir: string;
let imagePath: string;

liveDescribe("CLI vision backend live", () => {
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-cli-vqa-live-"));
    imagePath = path.join(dir, "red.png");
    await sharp({
      create: {
        width: 320,
        height: 120,
        channels: 3,
        background: { r: 220, g: 30, b: 30 },
      },
    })
      .png()
      .toFile(imagePath);
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("views a real screenshot and records real usage", async () => {
    const result = await askAboutImage(
      imagePath,
      [{ id: "color", question: "What is the dominant background color?" }],
      { backend: "cli", noCache: true, timeoutMs: 200_000 },
    );
    expect(result.provenance.backend).toBe("cli");
    expect(result.provenance.usage.inputTokens).toBeGreaterThan(0);
    expect(result.provenance.usage.outputTokens).toBeGreaterThan(0);
    const color = result.answers.find((a) => a.id === "color");
    expect(color?.answer.toLowerCase()).toContain("red");
    expect(color?.confidence).toBeGreaterThan(0.5);
  }, 210_000);
});
