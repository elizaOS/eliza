/**
 * Unit tests for the mvp-visual-verify pure functions: the ported color
 * classifier (asserted for PARITY against the audit's own `bucket()` so the two
 * cannot drift), the dominant-color quantizer over synthetic RGBA buffers, the
 * pixel-diff summarizer/comparator, and the declarative expectation evaluator.
 * All deterministic — no image decode, no tesseract, no browser.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  bucket,
  bucketRgb,
  parseRgb,
} from "../../scripts/mvp-visual-verify/color-bucket.mjs";
import {
  comparePixels,
  summarizeDiff,
} from "../../scripts/mvp-visual-verify/diff.mjs";
import { quantizePalette } from "../../scripts/mvp-visual-verify/dominant-color.mjs";
import {
  evaluateExpectations,
  resolveSpec,
} from "../../scripts/mvp-visual-verify/expectation-eval.mjs";
import { bucket as auditBucket } from "../ui-smoke/aesthetic-audit-rules";

const appPackageJson = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
) as { scripts: Record<string, string> };

describe("color-bucket", () => {
  it("parses rgb and rgba", () => {
    expect(parseRgb("rgb(255, 88, 0)")).toEqual([255, 88, 0, 1]);
    expect(parseRgb("rgba(10, 10, 40, 0.5)")).toEqual([10, 10, 40, 0.5]);
    expect(parseRgb("#ff5800")).toBeNull();
  });

  it("classifies brand orange, blue, black, white, transparent", () => {
    expect(bucket("rgb(255, 88, 0)")).toBe("orange"); // shipped accent, g=88
    expect(bucket("rgb(10, 10, 40)")).toBe("blue"); // saturated navy
    expect(bucket("rgb(0, 0, 0)")).toBe("black");
    expect(bucket("rgb(255, 255, 255)")).toBe("white");
    expect(bucket("rgba(200, 100, 0, 0)")).toBe("transparent");
    // Dark scrim: high chroma/max ratio but tiny absolute chroma → black, not blue.
    expect(bucket("rgba(10, 10, 12, 0.5)")).toBe("black");
  });

  it("is byte-for-byte parity with the audit rules bucket()", () => {
    // Sweep the RGB cube coarsely + edge cases; the ported classifier must agree
    // with the audit's canonical policy on every sample or the no-blue guarantee
    // diverges between capture and post-process.
    const samples: string[] = [];
    for (let r = 0; r <= 255; r += 51)
      for (let g = 0; g <= 255; g += 51)
        for (let b = 0; b <= 255; b += 51)
          samples.push(`rgb(${r}, ${g}, ${b})`);
    samples.push(
      "rgba(255,88,0,1)",
      "rgba(10,10,40,1)",
      "rgba(10,10,12,0.5)",
      "rgba(0,0,0,0)",
    );
    for (const s of samples) expect(bucket(s), s).toBe(auditBucket(s));
  });

  it("bucketRgb matches bucket for a triple", () => {
    expect(bucketRgb(255, 88, 0)).toBe("orange");
    expect(bucketRgb(128, 128, 128)).toBe("neutral");
    expect(bucketRgb(20, 20, 20)).toBe("black"); // luminance 0.078 < 0.08
  });
});

describe("quantizePalette", () => {
  /** Build a WxH RGBA buffer from a flat [r,g,b,a] fill or a per-pixel fn. */
  function makeBuffer(
    w: number,
    h: number,
    fill: (i: number) => [number, number, number, number],
  ) {
    const buf = Buffer.alloc(w * h * 4);
    for (let p = 0; p < w * h; p += 1) {
      const [r, g, b, a] = fill(p);
      buf[p * 4] = r;
      buf[p * 4 + 1] = g;
      buf[p * 4 + 2] = b;
      buf[p * 4 + 3] = a;
    }
    return buf;
  }

  it("ranks dominant colors by coverage and labels buckets", () => {
    // 75% orange, 25% blue.
    const buf = makeBuffer(4, 4, (i) =>
      i < 12 ? [255, 88, 0, 255] : [10, 10, 200, 255],
    );
    const { swatches, buckets, totalOpaque } = quantizePalette(buf, {
      step: 16,
      topK: 4,
    });
    expect(totalOpaque).toBe(16);
    expect(swatches[0].bucket).toBe("orange");
    expect(swatches[0].ratio).toBeCloseTo(0.75, 5);
    expect(swatches[1].bucket).toBe("blue");
    expect(buckets.orange).toBeCloseTo(0.75, 5);
    expect(buckets.blue).toBeCloseTo(0.25, 5);
  });

  it("skips fully transparent pixels", () => {
    const buf = makeBuffer(2, 2, (i) =>
      i === 0 ? [255, 88, 0, 255] : [0, 0, 0, 0],
    );
    const { totalOpaque, swatches } = quantizePalette(buf);
    expect(totalOpaque).toBe(1);
    expect(swatches[0].ratio).toBe(1);
  });

  it("throws on a non-RGBA buffer length", () => {
    expect(() => quantizePalette(Buffer.alloc(5))).toThrow(/multiple of 4/);
  });
});

describe("diff", () => {
  it("summarizeDiff computes percent + per-channel mean delta", () => {
    const s = summarizeDiff({
      changedPixels: 25,
      totalPixels: 100,
      sumAbsDelta: 3000,
    });
    expect(s.changedRatio).toBe(0.25);
    expect(s.changedPercent).toBe(25);
    expect(s.meanAbsDelta).toBe(10); // 3000 / (100*3)
    expect(s.resized).toBe(false);
  });

  it("summarizeDiff rejects a zero-pixel image (no false 0% pass)", () => {
    expect(() =>
      summarizeDiff({ changedPixels: 0, totalPixels: 0, sumAbsDelta: 0 }),
    ).toThrow();
  });

  it("comparePixels counts pixels above the threshold and builds a highlight", () => {
    const w = 2;
    const h = 1;
    const a = Buffer.from([0, 0, 0, 255, 0, 0, 0, 255]);
    const b = Buffer.from([0, 0, 0, 255, 200, 0, 0, 255]); // pixel 1 differs by 200
    const { changedPixels, totalPixels, sumAbsDelta, highlight } =
      comparePixels(a, b, w, h, {
        threshold: 30,
        buildHighlight: true,
      });
    expect(totalPixels).toBe(2);
    expect(changedPixels).toBe(1);
    expect(sumAbsDelta).toBe(200);
    expect(highlight).not.toBeNull();
    // Changed pixel is highlighted magenta.
    const px = highlight ?? Buffer.alloc(0);
    expect([px[4], px[5], px[6]]).toEqual([255, 0, 255]);
  });

  it("comparePixels throws when a buffer is too small", () => {
    expect(() => comparePixels(Buffer.alloc(4), Buffer.alloc(2), 2, 1)).toThrow(
      /too small/,
    );
  });
});

describe("expectation-eval", () => {
  const palette = (
    buckets: Record<string, number>,
    swatches: { bucket: string }[] = [],
  ) => ({
    buckets,
    swatches,
  });
  const okOcr = (text: string) => ({ available: true as const, text });

  it("no-blue fails on DOM blue, passes when clean", () => {
    const fail = evaluateExpectations(
      {
        ocr: okOcr(""),
        palette: palette({ neutral: 1 }),
        finding: { blueColors: ["rgb(0,0,255)"] },
      },
      { noBlue: true },
    );
    expect(fail.pass).toBe(false);
    expect(fail.reasons[0]).toMatch(/no-blue/);
    const pass = evaluateExpectations(
      {
        ocr: okOcr(""),
        palette: palette({ orange: 0.9 }),
        finding: { blueColors: [] },
      },
      { noBlue: true },
    );
    expect(pass.pass).toBe(true);
  });

  it("no-blue fails when palette blue coverage exceeds the limit", () => {
    const r = evaluateExpectations(
      {
        ocr: okOcr(""),
        palette: palette({ blue: 0.2 }),
        finding: { blueColors: [] },
      },
      { noBlue: true, blueCoverageLimit: 0.05 },
    );
    expect(r.pass).toBe(false);
  });

  it("accent-orange fails when orange is absent", () => {
    const r = evaluateExpectations(
      { ocr: okOcr(""), palette: palette({ neutral: 1 }), finding: null },
      { accentOrange: true },
    );
    expect(r.pass).toBe(false);
    const ok = evaluateExpectations(
      { ocr: okOcr(""), palette: palette({ orange: 0.01 }), finding: null },
      { accentOrange: true },
    );
    expect(ok.pass).toBe(true);
  });

  it("no-horizontal-overflow: skip when unknown, fail over tolerance, pass within", () => {
    const skip = evaluateExpectations(
      { ocr: okOcr(""), palette: palette({}), finding: {} },
      { noHorizontalOverflow: true },
    );
    expect(skip.checks[0].status).toBe("skip");
    expect(skip.pass).toBe(true); // a skip is not a fail

    const fail = evaluateExpectations(
      {
        ocr: okOcr(""),
        palette: palette({}),
        finding: { horizontalOverflowPx: 40 },
      },
      { noHorizontalOverflow: true },
    );
    expect(fail.pass).toBe(false);
    expect(fail.reasons[0]).toMatch(/horizontal overflow 40px/);

    const pass = evaluateExpectations(
      {
        ocr: okOcr(""),
        palette: palette({}),
        finding: { horizontalOverflowPx: 1 },
      },
      { noHorizontalOverflow: true },
    );
    expect(pass.pass).toBe(true);
  });

  it("OCR absent junk is whole-word: 'nan' inside 'finances' does not fire", () => {
    const spec = { ocr: { absent: ["NaN"] } };
    const clean = evaluateExpectations(
      {
        ocr: okOcr("Finances Focus Goals"),
        palette: palette({}),
        finding: null,
      },
      spec,
    );
    expect(clean.pass).toBe(true);
    const dirty = evaluateExpectations(
      { ocr: okOcr("value is NaN here"), palette: palette({}), finding: null },
      spec,
    );
    expect(dirty.pass).toBe(false);
    expect(dirty.reasons[0]).toMatch(/forbidden/);
  });

  it("OCR punctuation junk uses substring match", () => {
    const r = evaluateExpectations(
      {
        ocr: okOcr("caption [object Object] tail"),
        palette: palette({}),
        finding: null,
      },
      { ocr: { absent: ["[object Object]"] } },
    );
    expect(r.pass).toBe(false);
  });

  it("OCR present is per-viewport scoped", () => {
    const spec = {
      ocr: {
        present: ["Automations"],
        perViewport: { desktop: { present: ["Tasks"] } },
      },
    };
    // Desktop requires both; mobile requires only the universal token.
    const desktopFail = evaluateExpectations(
      {
        viewport: "desktop",
        ocr: okOcr("Automations Workflows"),
        palette: palette({}),
        finding: null,
      },
      spec,
    );
    expect(desktopFail.pass).toBe(false);
    expect(desktopFail.reasons[0]).toMatch(/Tasks/);
    const mobilePass = evaluateExpectations(
      {
        viewport: "mobile-portrait",
        ocr: okOcr("Automations Workflows"),
        palette: palette({}),
        finding: null,
      },
      spec,
    );
    expect(mobilePass.pass).toBe(true);
  });

  it("OCR check fails when required text cannot be verified", () => {
    const r = evaluateExpectations(
      {
        ocr: { available: false, reason: "tesseract not found" },
        palette: palette({}),
        finding: null,
      },
      { ocr: { present: ["Anything"] } },
    );
    expect(r.checks[0].status).toBe("fail");
    expect(r.pass).toBe(false);
  });

  it("resolveSpec merges __default__ invariants with the per-slug entry", () => {
    const specs = {
      __default__: { noBlue: true, ocr: { absent: ["undefined"] } },
      "builtin-settings": { accentOrange: true, ocr: { present: ["Models"] } },
    };
    const merged = resolveSpec(specs, "builtin-settings");
    expect(merged.noBlue).toBe(true);
    expect(merged.accentOrange).toBe(true);
    expect(merged.ocr.absent).toContain("undefined");
    expect(merged.ocr.present).toContain("Models");
    // An unlisted slug still gets the universal invariants.
    const dflt = resolveSpec(specs, "builtin-unknown");
    expect(dflt.noBlue).toBe(true);
  });
});

// The resting home (audit slug `builtin-chat`, mounted at /chat) is sparse by
// doctrine (#14343): time/weather + wallet + notifications + self-hiding LifeOps
// keepers. The seven non-MVP widgets (orchestrator activity/apps, feed activity,
// workflow tasks, finances, relationships, inbox) were removed from the home
// slot; this drives the REAL committed `builtin-chat` spec so the expected-absent
// OCR guard both passes on a clean sparse home and fires the instant a removed
// widget's signature text reappears there.
describe("sparse-home OCR regression guard (#14343)", () => {
  const specs = JSON.parse(
    readFileSync(
      path.resolve(
        __dirname,
        "../../scripts/mvp-visual-verify/expectations.json",
      ),
      "utf8",
    ),
  );
  const homeSpec = resolveSpec(specs, "builtin-chat");

  function ocrCheck(text: string) {
    const result = evaluateExpectations(
      {
        viewport: "desktop",
        ocr: { available: true as const, text },
        palette: { buckets: { orange: 0.01 }, swatches: [] },
        finding: { blueColors: [], horizontalOverflowPx: 0 },
      },
      homeSpec,
    );
    return result.checks.find((c) => c.name === "ocr-text");
  }

  it("declares expected-absent tokens for all seven removed widgets on builtin-chat", () => {
    // One signature token per removed widget so a regression re-mounting any of
    // the seven on the home slot trips the guard: orchestrator activity, apps,
    // feed activity, finances, relationships, inbox, workflow automations.
    expect(homeSpec.ocr.absent).toEqual(
      expect.arrayContaining([
        "orchestrator",
        "Agent activity",
        "App runs",
        "Bills & Balance",
        "Overdrawn",
        "Reach out",
        "Inbox",
        "Automations",
      ]),
    );
  });

  it("passes for a quiet sparse home (no removed-widget text present)", () => {
    // A realistic quiet-account home readout: greeting + weather + wallet prices
    // + a self-hiding keeper. None of the removed widgets' text appears.
    const sparse =
      "Good evening Weather 68 Partly cloudy BTC 64,120 ETH 3,410 SOL 172 Upcoming Dentist tomorrow 9:00 AM Todos";
    const check = ocrCheck(sparse);
    expect(check?.status).toBe("pass");
  });

  it("fires when any removed widget's signature text returns to the home", () => {
    // Each removed widget's OCR-visible text must trip the guard so a regression
    // that re-mounts it on the home slot is caught.
    for (const regressed of [
      "Agent activity 5 new events", // feed.agent-activity
      "orchestrator run blocked", // agent-orchestrator.activity
      "App runs 2 live", // agent-orchestrator.apps
      "Bills & Balance overdue", // finances.alerts
      "Overdrawn by 40", // finances.alerts
      "Reach out to Dana", // relationships.attention
      "Inbox 3 unread", // inbox.unread
      "Automations 2 running", // workflow.running
    ]) {
      const check = ocrCheck(`Good evening ${regressed}`);
      expect(check?.status, regressed).toBe("fail");
      expect(check?.detail, regressed).toMatch(/forbidden/);
    }
  });
});

describe("mvp-visual-verify CLI", () => {
  it("strict mode fails when the run has skipped checks or first-run baselines", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eliza-mvp-visual-verify-"));
    const baselineDir = path.join(dir, "empty-baseline");
    const viewportDir = path.join(dir, "mobile-portrait");
    mkdirSync(baselineDir);
    mkdirSync(viewportDir);
    await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 255, g: 88, b: 0, alpha: 1 },
      },
    })
      .png()
      .toFile(path.join(viewportDir, "builtin-chat.png"));

    let failed = false;
    try {
      execFileSync(
        process.execPath,
        [
          path.resolve(__dirname, "../../scripts/mvp-visual-verify.mjs"),
          "--input",
          dir,
          "--baseline",
          baselineDir,
          "--strict",
        ],
        {
          cwd: path.resolve(__dirname, "../.."),
          encoding: "utf8",
          stdio: "pipe",
        },
      );
    } catch (error) {
      failed = true;
      expect(error.status).toBe(1);
    }

    expect(failed).toBe(true);
    const report = JSON.parse(
      readFileSync(path.join(dir, "mvp-verify", "report.json"), "utf8"),
    );
    expect(report.summary.newBaselines).toBe(1);
    expect(report.summary.expectationSkips).toBeGreaterThan(0);
  });
});

describe("audit:app OCR command contract", () => {
  it("keeps the canonical audit command wired to packaged OCR", () => {
    expect(appPackageJson.scripts["audit:app:capture"]).toContain(
      "--project=audit-app",
    );
    expect(appPackageJson.scripts["audit:app"]).toContain(
      "bun run audit:app:capture",
    );
    expect(appPackageJson.scripts["audit:app"]).toContain(
      "ELIZA_MVP_OCR_ENGINE=packaged bun run audit:ocr",
    );
    expect(appPackageJson.scripts["audit:app:verify"]).toContain(
      "ELIZA_MVP_OCR_ENGINE=packaged bun run mvp:visual-verify -- --strict",
    );
  });
});
