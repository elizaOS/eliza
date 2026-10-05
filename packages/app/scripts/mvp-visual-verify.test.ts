/**
 * Exercises the deterministic contact-sheet HTML boundary with adversarial
 * report strings; image, OCR, and browser capture integrations are not mocked
 * because this suite targets only serialization of an already-built report.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadBaselineManifest,
  recordBaseline,
  requiredBaselineStates,
  resolveBaselinePath,
  saveBaselineManifest,
} from "./mvp-visual-verify/baselines.ts";
import {
  contactSheetSwatchColor,
  escapeContactSheetHtml,
  renderContactSheet,
} from "./mvp-visual-verify/html-report.ts";

describe("visual baseline identity", () => {
  test("shares image bytes without losing states or coupling later updates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-baselines-"));
    try {
      const source = path.join(root, "capture.png");
      await writeFile(source, "same capture bytes");
      const manifest = await loadBaselineManifest(root);
      await recordBaseline(root, manifest, "desktop", "apps", source);
      await recordBaseline(root, manifest, "mobile", "apps", source);
      const original = resolveBaselinePath(root, manifest, "desktop", "apps");
      expect(resolveBaselinePath(root, manifest, "mobile", "apps")).toBe(
        original,
      );
      expect(requiredBaselineStates(manifest, [])).toEqual([
        "apps@desktop",
        "apps@mobile",
      ]);
      expect(requiredBaselineStates(manifest, ["mobile"])).toEqual([
        "apps@mobile",
      ]);
      await writeFile(source, "updated mobile capture");
      await recordBaseline(root, manifest, "mobile", "apps", source);
      expect(resolveBaselinePath(root, manifest, "desktop", "apps")).toBe(
        original,
      );
      expect(resolveBaselinePath(root, manifest, "mobile", "apps")).not.toBe(
        original,
      );
      await saveBaselineManifest(root, manifest);
      expect(await loadBaselineManifest(root)).toEqual(manifest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects malformed manifests and paths outside the baseline store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-baselines-invalid-"));
    try {
      await writeFile(
        path.join(root, "manifest.json"),
        JSON.stringify({
          version: 1,
          states: { "desktop/apps": "../../outside.png" },
        }),
      );
      await expect(loadBaselineManifest(root)).rejects.toThrow(
        "Invalid visual baseline entry",
      );
      expect(() =>
        resolveBaselinePath(root, { version: 1, states: {} }, "..", "apps"),
      ).toThrow("Invalid baseline state");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("contact-sheet HTML serialization", () => {
  test("escapes text and quoted-attribute metacharacters", () => {
    expect(escapeContactSheetHtml(`<tag a="b" c='d'>&`)).toBe(
      "&lt;tag a=&quot;b&quot; c=&#039;d&#039;&gt;&amp;",
    );
  });

  test("allows only six-digit hex colors in inline styles", () => {
    expect(contactSheetSwatchColor("#aBc123")).toBe("#aBc123");
    expect(contactSheetSwatchColor('#fff;" onmouseover="alert(1)')).toBe(
      "transparent",
    );
  });

  test("keeps quotes, ampersands, and style payloads inside report data", () => {
    const payload = `" onmouseover="alert(1) & <script data-owned='no'>`;
    const html = renderContactSheet(
      {
        states: 1,
        ocrEngine: payload,
        expectationFailures: 0,
        expectationSkips: 0,
        missingRequiredStates: [],
        overflowStates: 0,
        newBaselines: 0,
        auditReportPresent: true,
        baselineDir: payload,
        generatedAt: payload,
      },
      [
        {
          slug: payload,
          viewport: payload,
          screenshot: `shot-${payload}.png`,
          ocr: { available: true, text: payload, words: 1 },
          palette: {
            swatches: [{ hex: payload, bucket: payload, ratio: 0.5 }],
            buckets: { [payload]: 1 },
          },
          diff: {
            status: "compared",
            changedPercent: 0,
            resized: false,
            diffPng: `diff-${payload}.png`,
          },
          expectation: {
            pass: true,
            checks: [{ status: payload, name: payload, detail: payload }],
          },
        },
      ],
    );

    expect(html).not.toContain("<script data-owned");
    expect(html).not.toContain(' onmouseover="alert(1)');
    expect(html).not.toContain(`class="chk ${payload}`);
    expect(html).not.toContain("background:&quot;");
    expect(html).toContain('class="chk unknown"');
    expect(html).toContain('style="background:transparent"');
    expect(html).toContain("&quot; onmouseover=&quot;alert(1) &amp;");
  });
});
