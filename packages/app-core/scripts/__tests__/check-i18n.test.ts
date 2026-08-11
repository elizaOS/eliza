/**
 * Pins the i18n catalog contract (#17605) against synthetic fixture trees and
 * the real repo. Errors: a literal key missing from the SOURCE locale, an
 * unused source-locale key, an orphaned translation (locale key absent from
 * the source catalog), and a stale `uncatalogued` entry. Warnings (errors only
 * under strictTranslations): non-source locales missing used keys or lagging
 * the source catalog. The real-repo case asserts the checker stays wireable —
 * ok:true with translation gaps surfaced as warnings. Deterministic, no
 * network.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const { runI18nCheck } = await import(
  new URL("../check-i18n.mjs", import.meta.url).href
);

const REAL_REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

interface CheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stats?: Record<string, number>;
}

function buildFixture({
  en = { "app.title": "Hello" },
  locales = {},
  source = 'export const x = t("app.title");\n',
  allowlist,
}: {
  en?: Record<string, string>;
  locales?: Record<string, Record<string, string>>;
  source?: string;
  allowlist?: unknown;
}): { root: string; options: Record<string, unknown> } {
  const root = mkdtempSync(join(tmpdir(), "check-i18n-"));
  const localeDir = join(root, "locales");
  const srcDir = join(root, "src");
  mkdirSync(localeDir, { recursive: true });
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(localeDir, "en.json"), JSON.stringify(en));
  for (const [lang, data] of Object.entries(locales)) {
    writeFileSync(join(localeDir, `${lang}.json`), JSON.stringify(data));
  }
  writeFileSync(join(srcDir, "app.tsx"), source);
  // Always write one. The checker now fails closed on a MISSING allowlist,
  // because an absent file silently disabled the dynamic-key and uncatalogued
  // rules while still exiting 0. "No allowlist" and "an empty allowlist" are
  // different states, and a fixture that wants the second has to say so.
  const allowlistPath = join(root, "allowlist.json");
  writeFileSync(
    allowlistPath,
    JSON.stringify(allowlist ?? { keys: [], prefixes: [], uncatalogued: [] }),
  );
  return {
    root,
    options: {
      repoRoot: root,
      localeDir,
      scanDirs: [srcDir],
      allowlistPath,
    },
  };
}

function run(
  fixture: { root: string; options: Record<string, unknown> },
  extra: Record<string, unknown> = {},
): CheckResult {
  try {
    return runI18nCheck({ ...fixture.options, ...extra });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

describe("check-i18n contract", () => {
  test("passes a clean tree", () => {
    const result = run(buildFixture({}));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("fails when a used key is missing from the source locale", () => {
    const result = run(
      buildFixture({
        en: {},
        source: 'export const x = t("app.missing");\n',
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/en\.json missing 1 key/);
  });

  test("reports a non-source gap as a warning, not an error", () => {
    const result = run(
      buildFixture({
        locales: { es: {} },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/es\.json missing 1 key/);
    expect(result.warnings.join("\n")).toMatch(
      /es\.json is missing 1 translation/,
    );
  });

  test("--strict-translations upgrades non-source gaps to errors", () => {
    const result = run(
      buildFixture({
        locales: { es: {} },
      }),
      { strictTranslations: true },
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/es\.json missing 1 key/);
  });

  test("reports an unreferenced source key as ADVISORY, never as grounds for deletion", () => {
    // Deliberately not an error: a static scan cannot see metadata-driven or
    // ref-wrapped call sites, and acting on this list once removed 86 live
    // keys across eight locales. The checker nominates; a human verifies.
    const result = run(
      buildFixture({
        en: { "app.title": "Hello", "app.dead": "Never rendered" },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/ADVISORY/);
    expect(result.warnings.join("\n")).toMatch(/app\.dead/);
  });

  test("fails on an orphaned translation absent from the source catalog", () => {
    const result = run(
      buildFixture({
        locales: { es: { "app.title": "Hola", "app.ghost": "Fantasma" } },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/orphaned translation/);
    expect(result.errors.join("\n")).toMatch(/app\.ghost/);
  });

  test("uncatalogued keys are exempt from the source-catalog requirement", () => {
    const result = run(
      buildFixture({
        source:
          'export const x = t("app.title");\nexport const y = t("app.conditional", { defaultValue: cond ? "A" : "B" });\n',
        allowlist: {
          keys: [],
          prefixes: [],
          uncatalogued: [
            { key: "app.conditional", reason: "runtime-conditional default" },
          ],
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("fails when an uncatalogued entry no longer has a call site", () => {
    const result = run(
      buildFixture({
        allowlist: {
          keys: [],
          prefixes: [],
          uncatalogued: [{ key: "app.gone", reason: "stale entry" }],
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/no longer used in source/);
  });

  test("counts keys reached through the tRef.current stable-ref indirection", () => {
    // `const tRef = useRef(t)` then `tRef.current("key")` is a real call site.
    // Missing it made live keys look dead: the purge in this checker's own
    // repair PR deleted documentsview.FailedToLoadDocumentsData from all eight
    // locales because only `t("...")` was matched.
    const result = run(
      buildFixture({
        en: { "app.title": "Hello", "app.viaRef": "Loaded through a ref" },
        source:
          'export const x = t("app.title");\nuseEffect(() => { tRef.current("app.viaRef", { defaultValue: "Loaded through a ref" }); });\n',
      }),
    );
    // Neither unused (it IS referenced) nor missing (it IS catalogued).
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("flags a tRef.current key that is absent from the source catalog", () => {
    const result = run(
      buildFixture({
        en: { "app.title": "Hello" },
        source:
          'export const x = t("app.title");\nexport const y = tRef.current("app.missingViaRef");\n',
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/en\.json missing 1 key/);
  });

  test("template prefixes from source cover dynamically-built keys", () => {
    const result = run(
      buildFixture({
        en: { "app.title": "Hello", "step.one": "One", "step.two": "Two" },
        source:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture IS a template-literal t() call under test
          'export const x = t("app.title");\nexport const y = t(`step.${name}`);\n',
      }),
    );
    expect(result.ok).toBe(true);
  });

  // Unlike every fixture case above, this one walks the real packages/ui/src and
  // packages/app-core/src trees synchronously: ~5-8s locally, and a CI runner on
  // a cold filesystem is not faster. bun's default per-test budget is 5s, so
  // without an explicit one this test fails on duration alone — which is the
  // wrong signal from the very case that exists to prove the checker is
  // wireable into CI.
  test("the real repo satisfies the contract (wireable: gaps stay warnings)", () => {
    const result = runI18nCheck({ repoRoot: REAL_REPO_ROOT }) as CheckResult;
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    // Translation debt exists and must stay VISIBLE as warnings — a silent
    // pass would hide the backfill work the same way the unwired checker did.
    expect(result.warnings.some((w) => /missing \d+ translation/.test(w))).toBe(
      true,
    );
  }, 60_000);

  test("fails closed when the allowlist file is missing", () => {
    // The default path pointed at packages/scripts/i18n-dynamic-keys.json,
    // which does not exist — the file lives under packages/app-core/scripts.
    // loadAllowlist answered that with an empty allowlist, so the dynamic-key
    // and uncatalogued rules silently did not run and the checker still exited
    // 0. A missing allowlist is a broken invocation, not an empty allowlist.
    const fixture = buildFixture({});
    rmSync(String(fixture.options.allowlistPath), { force: true });
    expect(() => run(fixture)).toThrow(/allowlist not found/);
  });

  test("an explicitly empty allowlist is honoured, not treated as missing", () => {
    // The other half of the same contract: declaring "no dynamic keys" must
    // stay a legitimate configuration, or fail-closed would just be noise.
    const result = run(
      buildFixture({ allowlist: { keys: [], prefixes: [], uncatalogued: [] } }),
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
