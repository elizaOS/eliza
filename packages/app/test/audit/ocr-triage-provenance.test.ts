/**
 * Proves the OCR triage accepts exactly the current report manifest through both its function and real CLI boundaries.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAuditAppOutput } from "../../scripts/lib/audit-output.mjs";
import {
  authorizedShots,
  type ReportEntry,
  runOcrTriage,
  validateImportedOcrRecords,
} from "../../scripts/ocr-triage";

// Changed-file coverage invokes Vitest from the repository root while the
// package script invokes it from `packages/app`. Vitest gives `import.meta.url`
// a virtual scheme, so select between those two documented cwd contracts by
// probing for the CLI rather than assuming the package-root invocation.
const appDirCandidates = [
  process.cwd(),
  join(process.cwd(), "packages", "app"),
].filter((candidate) =>
  existsSync(join(candidate, "scripts", "ocr-triage.ts")),
);
if (appDirCandidates.length !== 1) {
  throw new Error(
    `Expected one app package root from ${process.cwd()}, found ${appDirCandidates.length}`,
  );
}
const [APP_DIR] = appDirCandidates;
const CLI = join(APP_DIR, "scripts", "ocr-triage.ts");

/** Multicolor pixels keep provenance fixtures outside the proven-blank path. */
const PNG_2x2 = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000200000002080600000" +
    "072b60d240000000970485973000003e8000003e801b57b526b000000" +
    "1349444154789c63f8cfc0f01f0c1918fe83010049c809f71463329d" +
    "0000000049454e44ae426082",
  "hex",
);
function shot(dir: string, viewport: string, slug: string): void {
  const vp = join(dir, viewport);
  mkdirSync(vp, { recursive: true });
  writeFileSync(join(vp, `${slug}.png`), PNG_2x2);
}

function ocrLine(viewport: string, slug: string, text: string): string {
  return JSON.stringify({
    path: join(viewport, `${slug}.png`),
    ok: true,
    text,
    lines: text.split("\n").filter(Boolean),
    words: text.split(/\s+/).filter(Boolean).length,
    meanConfidence: 1,
  });
}

// Slugs with no VIEW_EXPECTATIONS so the OCR verdict cannot confound the gate
// exit code — this test asserts provenance (which rows are triaged), not verdict.
const CURRENT_ROWS: ReportEntry[] = [
  { slug: "builtin-chat", viewport: "desktop-landscape", verdict: "good" },
  { slug: "builtin-phone", viewport: "desktop-landscape", verdict: "good" },
];
const STALE_SLUG = "plugin-retired-gui";

describe("authorizedShots (report-authoritative selection)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ocr-authz-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("selects exactly one shot per report row", () => {
    for (const r of CURRENT_ROWS) shot(dir, r.viewport, r.slug);
    const shots = authorizedShots(dir, CURRENT_ROWS);
    expect(shots.map((s) => s.key).sort()).toEqual([
      "builtin-chat::desktop-landscape",
      "builtin-phone::desktop-landscape",
    ]);
  });

  it("ignores a stale PNG that no current row names", () => {
    for (const r of CURRENT_ROWS) shot(dir, r.viewport, r.slug);
    // A retired view left behind by an earlier capture (the #15790 symptom).
    shot(dir, "desktop-landscape", STALE_SLUG);
    const shots = authorizedShots(dir, CURRENT_ROWS);
    expect(shots).toHaveLength(CURRENT_ROWS.length);
    expect(shots.some((s) => s.slug.includes("social-alpha"))).toBe(false);
  });

  it("fails fast when a report row has no screenshot", () => {
    shot(dir, "desktop-landscape", "builtin-chat");
    // builtin-phone.png intentionally absent.
    expect(() => authorizedShots(dir, CURRENT_ROWS)).toThrow(
      /screenshot is missing: builtin-phone::desktop-landscape/,
    );
  });

  it("fails fast on a duplicate report row", () => {
    for (const r of CURRENT_ROWS) shot(dir, r.viewport, r.slug);
    expect(() =>
      authorizedShots(dir, [...CURRENT_ROWS, CURRENT_ROWS[0]]),
    ).toThrow(/Duplicate audit report row: builtin-chat::desktop-landscape/);
  });

  it("fails fast on an empty report", () => {
    expect(() => authorizedShots(dir, [])).toThrow(
      /contains no screenshot rows/,
    );
  });
});

describe("ocr-triage CLI (end-to-end provenance)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ocr-cli-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(): { status: number; stderr: string } {
    try {
      execFileSync(
        "bun",
        [
          CLI,
          "--audit-dir",
          dir,
          "--ocr",
          join(dir, "ocr.ndjson"),
          "--out",
          join(dir, "ocr-triage.json"),
        ],
        { cwd: APP_DIR, encoding: "utf8", stdio: "pipe" },
      );
      return { status: 0, stderr: "" };
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      return { status: err.status ?? 1, stderr: err.stderr ?? "" };
    }
  }

  it("writes an exact manifest result and accounts for known pixel regressions", async () => {
    const rows: ReportEntry[] = [
      {
        slug: "builtin-settings",
        viewport: "desktop-landscape",
        verdict: "good",
      },
      {
        slug: "plugin-readable-gui",
        viewport: "mobile-portrait",
        verdict: "good",
      },
      {
        slug: "plugin-broken-gui",
        viewport: "ipad-portrait",
        verdict: "needs-eyeball",
      },
    ];
    for (const row of rows) shot(dir, row.viewport, row.slug);
    writeFileSync(join(dir, "report.json"), JSON.stringify(rows));
    writeFileSync(
      join(dir, "ocr.ndjson"),
      [
        ocrLine("desktop-landscape", "builtin-settings", "Settings Voice"),
        ocrLine(
          "mobile-portrait",
          "plugin-readable-gui",
          "Readable plugin content",
        ),
        ocrLine(
          "ipad-portrait",
          "plugin-broken-gui",
          "TypeError Cannot read properties",
        ),
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "baseline.json"),
      JSON.stringify({ known: ["plugin-broken-gui::ipad-portrait"] }),
    );

    const result = await runOcrTriage([
      "--audit-dir",
      dir,
      "--ocr",
      join(dir, "ocr.ndjson"),
      "--out",
      join(dir, "ocr-triage.json"),
      "--baseline",
      join(dir, "baseline.json"),
    ]);

    expect(result.summary).toEqual({
      total: 3,
      verified: 1,
      broken: 1,
      needsEyeball: 1,
      regressions: 1,
      knownRegressions: 1,
      newRegressions: 0,
    });
    expect(result.entries.map((entry) => entry.slug)).toEqual([
      "plugin-broken-gui",
      "builtin-settings",
      "plugin-readable-gui",
    ]);
    expect(
      JSON.parse(readFileSync(join(dir, "ocr-triage.json"), "utf8")),
    ).toEqual(result);
  });

  it("rejects an OCR record that is not in the current report", async () => {
    for (const r of CURRENT_ROWS) shot(dir, r.viewport, r.slug);
    writeFileSync(join(dir, "report.json"), JSON.stringify(CURRENT_ROWS));
    // A retired-view PNG can remain on disk, but it is not authorized evidence.
    shot(dir, "desktop-landscape", STALE_SLUG);
    writeFileSync(
      join(dir, "ocr.ndjson"),
      [
        ocrLine("desktop-landscape", "builtin-chat", "Chat messages composer"),
        ocrLine("desktop-landscape", "builtin-phone", "Phone dialer keypad"),
        ocrLine("desktop-landscape", STALE_SLUG, "Retired plugin screenshot"),
      ].join("\n"),
    );

    await expect(
      runOcrTriage([
        "--audit-dir",
        dir,
        "--ocr",
        join(dir, "ocr.ndjson"),
        "--out",
        join(dir, "ocr-triage.json"),
      ]),
    ).rejects.toThrow(/OCR input is not in the current audit report/);

    const { status, stderr } = run();
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/OCR input is not in the current audit report/);
  });

  it("rejects imported OCR with missing, duplicate, unexpected, or mismatched records", () => {
    for (const r of CURRENT_ROWS) shot(dir, r.viewport, r.slug);
    const shots = authorizedShots(dir, CURRENT_ROWS);
    const chat = JSON.parse(
      ocrLine("desktop-landscape", "builtin-chat", "Chat messages composer"),
    );
    const phone = JSON.parse(
      ocrLine("desktop-landscape", "builtin-phone", "Phone dialer keypad"),
    );
    const stale = JSON.parse(
      ocrLine("desktop-landscape", STALE_SLUG, "Retired plugin screenshot"),
    );

    expect(() =>
      validateImportedOcrRecords(dir, "ocr.ndjson", shots, [chat]),
    ).toThrow(/builtin-phone::desktop-landscape has no OCR record/);
    expect(() =>
      validateImportedOcrRecords(dir, "ocr.ndjson", shots, [
        chat,
        phone,
        phone,
      ]),
    ).toThrow(/duplicate OCR record builtin-phone::desktop-landscape/);
    expect(() =>
      validateImportedOcrRecords(dir, "ocr.ndjson", shots, [
        chat,
        phone,
        stale,
      ]),
    ).toThrow(new RegExp(`unexpected OCR record ${STALE_SLUG}`));
    expect(() =>
      validateImportedOcrRecords(dir, "ocr.ndjson", shots, [
        {
          ...chat,
          path: join(
            tmpdir(),
            "elsewhere",
            "desktop-landscape",
            "builtin-chat.png",
          ),
        },
        phone,
      ]),
    ).toThrow(/builtin-chat::desktop-landscape points to/);
  });

  it("binds pixel diagnostics by screenshot path when OCR records arrive out of order", async () => {
    for (const r of CURRENT_ROWS) shot(dir, r.viewport, r.slug);
    await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 208, g: 216, b: 216, alpha: 1 },
      },
    })
      .png()
      .toFile(join(dir, "desktop-landscape", "builtin-chat.png"));
    writeFileSync(join(dir, "report.json"), JSON.stringify(CURRENT_ROWS));
    writeFileSync(
      join(dir, "ocr.ndjson"),
      [
        ocrLine("desktop-landscape", "builtin-phone", "Phone dialer keypad"),
        ocrLine("desktop-landscape", "builtin-chat", "Chat messages composer"),
      ].join("\n"),
    );

    const result = await runOcrTriage([
      "--audit-dir",
      dir,
      "--ocr",
      join(dir, "ocr.ndjson"),
      "--out",
      join(dir, "ocr-triage.json"),
    ]);
    const chat = result.entries.find((entry) => entry.slug === "builtin-chat");
    const phone = result.entries.find(
      (entry) => entry.slug === "builtin-phone",
    );
    if (!chat || !phone) throw new Error("expected current audit entries");
    expect(chat.pixelBlank).toBe(true);
    expect(phone.pixelBlank).toBe(false);
  });

  it("exits non-zero when imported OCR contains a stale record", async () => {
    for (const r of CURRENT_ROWS) shot(dir, r.viewport, r.slug);
    writeFileSync(join(dir, "report.json"), JSON.stringify(CURRENT_ROWS));
    writeFileSync(
      join(dir, "ocr.ndjson"),
      [
        ocrLine("desktop-landscape", "builtin-chat", "Chat messages composer"),
        ocrLine("desktop-landscape", "builtin-phone", "Phone dialer keypad"),
        ocrLine("desktop-landscape", STALE_SLUG, "Retired plugin screenshot"),
      ].join("\n"),
    );

    await expect(
      runOcrTriage([
        "--audit-dir",
        dir,
        "--ocr",
        join(dir, "ocr.ndjson"),
        "--out",
        join(dir, "ocr-triage.json"),
      ]),
    ).rejects.toThrow(/OCR input is not in the current audit report/);
    const { status, stderr } = run();
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/OCR input is not in the current audit report/);
  });

  it("exits non-zero when a report row's screenshot is missing", async () => {
    shot(dir, "desktop-landscape", "builtin-chat");
    // builtin-phone.png absent → incomplete capture.
    writeFileSync(join(dir, "report.json"), JSON.stringify(CURRENT_ROWS));
    writeFileSync(
      join(dir, "ocr.ndjson"),
      ocrLine("desktop-landscape", "builtin-chat", "Chat messages"),
    );
    await expect(
      runOcrTriage([
        "--audit-dir",
        dir,
        "--ocr",
        join(dir, "ocr.ndjson"),
        "--out",
        join(dir, "ocr-triage.json"),
      ]),
    ).rejects.toThrow(
      /screenshot is missing: builtin-phone::desktop-landscape/,
    );
    const { status, stderr } = run();
    expect(status).not.toBe(0);
    expect(stderr).toMatch(
      /screenshot is missing: builtin-phone::desktop-landscape/,
    );
  });

  it("rejects a malformed precomputed OCR record at the input boundary", async () => {
    for (const r of CURRENT_ROWS) shot(dir, r.viewport, r.slug);
    writeFileSync(join(dir, "report.json"), JSON.stringify(CURRENT_ROWS));
    writeFileSync(
      join(dir, "ocr.ndjson"),
      `${JSON.stringify({ path: join(dir, "desktop-landscape", "builtin-chat.png"), ok: true })}\n`,
    );

    await expect(
      runOcrTriage([
        "--audit-dir",
        dir,
        "--ocr",
        join(dir, "ocr.ndjson"),
        "--out",
        join(dir, "ocr-triage.json"),
      ]),
    ).rejects.toThrow(/Invalid OCR input record at line 1/);
  });
});

describe("audit runner cleanup", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "audit-runner-cleanup-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("rejects filesystem, repository, and app roots", () => {
    const repoRoot = join(APP_DIR, "..", "..");
    const resolveConfigured = (configured: string) =>
      resolveAuditAppOutput({ appDir: APP_DIR, repoRoot, configured });

    expect(() => resolveConfigured(APP_DIR)).toThrow(/unsafe audit output/);
    expect(() => resolveConfigured(repoRoot)).toThrow(/unsafe audit output/);
    expect(() => resolveConfigured("/")).toThrow(/unsafe audit output/);
    expect(() => resolveConfigured(join(APP_DIR, "..", "ui"))).toThrow(
      /unsafe audit output/,
    );
    expect(resolveConfigured(dir)).toBe(dir);
  });

  it("resets stale artifacts once before Playwright owns the run", () => {
    const stale = join(dir, "mobile-portrait", "plugin-retired-gui.png");
    mkdirSync(join(dir, "mobile-portrait"));
    writeFileSync(stale, PNG_2x2);

    const output = execFileSync(
      process.execPath,
      [
        join(APP_DIR, "scripts", "run-ui-playwright.mjs"),
        "--config",
        "playwright.ui-smoke.config.ts",
        "--project=audit-app",
        "--list",
      ],
      {
        cwd: APP_DIR,
        encoding: "utf8",
        env: {
          ...process.env,
          ELIZA_AUDIT_APP_DIR: dir,
          ELIZA_UI_SMOKE_SKIP_BUILD: "1",
          ELIZA_UI_SMOKE_SKIP_CORE_BUILD: "1",
          ELIZA_UI_SMOKE_SKIP_VIEW_BUILD: "1",
        },
      },
    );

    expect(output).toContain("Reset app aesthetic audit output");
    expect(output).toContain("Listing tests:");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  }, 30_000);
});
