/**
 * Real verification of the persistent WinRT OCR host (#9105 / #9581 follow-up).
 * Gated: runs only on Windows (the host is win32-only; elsewhere
 * `ocrHostAvailable()` is false and `describe()` uses its one-shot path).
 *
 * Renders a high-contrast text PNG with System.Drawing, then OCRs it through the
 * warm host and asserts: valid JSON of the expected shape, the host is fast once
 * warm (only achievable without per-call cold spawns), a nonexistent image is
 * answered (error-JSON, no hang), and the host survives an error.
 *
 * See `src/ocr-host-windows.ts`. Cold-vs-warm latency evidence is in the PR.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ocrHostAvailable,
  runOcrHost,
  shutdownOcrHost,
} from "./ocr-host-windows.js";

const RUN = platform() === "win32";

function makeTextPng(text: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ocrhost-test-"));
  const p = join(dir, "text.png").replace(/\//g, "\\");
  const ps = [
    "Add-Type -AssemblyName System.Drawing",
    "$b = New-Object System.Drawing.Bitmap(640, 200)",
    "$g = [System.Drawing.Graphics]::FromImage($b)",
    "$g.Clear([System.Drawing.Color]::White)",
    "$f = New-Object System.Drawing.Font('Arial', 48)",
    `$g.DrawString('${text}', $f, [System.Drawing.Brushes]::Black, 20, 60)`,
    "$g.Dispose()",
    `$b.Save('${p}')`,
    "$b.Dispose()",
  ].join("; ");
  execSync(`powershell -NoProfile -Command "${ps}"`, {
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { dir, path: p };
}

describe("ocr-host-windows (warm WinRT OCR host, Windows)", () => {
  afterAll(() => {
    shutdownOcrHost();
  });

  it.skipIf(!RUN)("is reported available on win32", () => {
    expect(ocrHostAvailable()).toBe(true);
  });

  it.skipIf(!RUN)(
    "recognizes text and returns the expected JSON shape",
    async () => {
      const { dir, path } = makeTextPng("INVOICE 4096");
      try {
        const json = await runOcrHost(path);
        const parsed = JSON.parse(json);
        expect(parsed.width).toBeGreaterThan(0);
        expect(parsed.height).toBeGreaterThan(0);
        expect(Array.isArray(parsed.lines)).toBe(true);
        const allText = (parsed.lines ?? [])
          .map((l: { text: string }) => l.text)
          .join(" ");
        // OCR is not byte-exact, but it should recover a distinctive token.
        expect(allText).toMatch(/4096|INVOICE/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.skipIf(!RUN)(
    "is fast once warm (no per-call cold spawn / WinRT reload)",
    async () => {
      const { dir, path } = makeTextPng("WARM 7");
      try {
        await runOcrHost(path); // warm
        const start = Date.now();
        for (let i = 0; i < 3; i++) await runOcrHost(path);
        const perCall = (Date.now() - start) / 3;
        // A cold spawn + WinRT load alone is ~10-16s; only the persistent host
        // can hold this ceiling.
        expect(perCall).toBeLessThan(4_000);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.skipIf(!RUN)(
    "answers a nonexistent image with error-JSON and stays usable",
    async () => {
      const bad = await runOcrHost(
        join(tmpdir(), "ocrhost-nope-zzz-does-not-exist.png"),
      );
      const parsed = JSON.parse(bad);
      expect(Array.isArray(parsed.lines)).toBe(true);
      expect(parsed.lines.length).toBe(0);
      const { dir, path } = makeTextPng("ALIVE");
      try {
        const ok = JSON.parse(await runOcrHost(path));
        expect(Array.isArray(ok.lines)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
