/**
 * Exercises the deterministic contact-sheet HTML boundary with adversarial
 * report strings; image, OCR, and browser capture integrations are not mocked
 * because this suite targets only serialization of an already-built report.
 */

import { describe, expect, test } from "bun:test";
import {
  contactSheetSwatchColor,
  escapeContactSheetHtml,
  renderContactSheet,
} from "./mvp-visual-verify/html-report.mjs";

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
