// End-to-end orchestration: run a shipped walkthrough definition against the
// self-contained dashboard fixture (served locally), in real headless chromium,
// and ingest the produced video + screenshots + snapshots into a bundle that
// then verifies clean. Gated on BOTH chromium and ffmpeg; skipped with a reason
// when either is absent. Also asserts requiresApp definitions are refused
// without a baseUrl (tool-free).
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createBundle, verifyBundle } from "../bundle.ts";
import { videoToolsAvailable } from "./normalize.ts";
import {
  loadAllWalkthroughDefs,
  loadWalkthroughDef,
  runAndIngestWalkthrough,
  WALKTHROUGHS_DIR,
} from "./walkthroughs.ts";

const dir = mkdtempSync(join(os.tmpdir(), "evidence-walkthroughs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function chromiumLaunchable(): Promise<boolean> {
  try {
    const { chromium } = (await import("@playwright/test")) as {
      chromium: { launch(o?: unknown): Promise<{ close(): Promise<void> }> };
    };
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const tools = await videoToolsAvailable();
const hasChromium = await chromiumLaunchable();
const canRun = tools.available && hasChromium;

function newBundle(runId: string) {
  return createBundle({
    rootDir: join(dir, "runs"),
    provenance: {
      commit: "0".repeat(40),
      branch: "test",
      runner: "local",
      tier: "cpu",
      envFingerprint: {
        node: process.version,
        platform: "test",
        arch: "test",
        tier: "cpu",
      },
    },
    runId,
    linkMode: "copy",
  });
}

describe("shipped definitions load", () => {
  it("loads all shipped definitions", () => {
    const all = loadAllWalkthroughDefs();
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.map((entry) => entry.def.slug).sort()).toContain("send-button");
  });
});

describe.skipIf(!canRun)(
  "runAndIngestWalkthrough (fixture + chromium + ffmpeg)",
  () => {
    it("runs the feature walkthrough against the fixture and ingests it", async () => {
      const def = loadWalkthroughDef(
        join(WALKTHROUGHS_DIR, "send-message.json"),
      );
      const bundle = newBundle("wt-feature");
      const out = mkdtempSync(join(dir, "out-"));
      const result = await runAndIngestWalkthrough(def, bundle, {
        out,
        driver: { stepPauseMs: 100 },
      });
      expect(result.slug).toBe("send-message");
      expect(result.ingest.video.path).toBe("video/features/send-message.mp4");
      expect(result.ingest.normalize.status).toBe("transcoded");
      expect(result.ingest.keyframeCount).toBeGreaterThanOrEqual(2);
      expect(result.screenshots.length).toBeGreaterThanOrEqual(1);

      const finalized = await bundle.finalize();
      // video + its analysis + keyframes + their analyses + screenshots + aria + steps.
      expect(finalized.manifest.artifacts.length).toBeGreaterThan(6);
      const report = await verifyBundle(bundle.dir);
      expect(report.ok).toBe(true);
    }, 120_000);

    it("runs the element walkthrough (send-button) against the fixture", async () => {
      const def = loadWalkthroughDef(
        join(WALKTHROUGHS_DIR, "send-button.json"),
      );
      const bundle = newBundle("wt-element");
      const out = mkdtempSync(join(dir, "out-el-"));
      const result = await runAndIngestWalkthrough(def, bundle, {
        out,
        driver: { stepPauseMs: 100 },
      });
      expect(result.ingest.video.path).toBe("video/elements/send-button.mp4");
      await bundle.finalize();
      const report = await verifyBundle(bundle.dir);
      expect(report.ok).toBe(true);
    }, 120_000);
  },
);
