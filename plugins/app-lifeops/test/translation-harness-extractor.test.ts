/**
 * Translation harness — extractor regression tests.
 *
 * Covers `scripts/translate-action-examples.mjs`'s `extractFromActionFile`
 * via fixture files in `test/fixtures/translate-action-examples/`. The
 * companion `translation-harness.test.ts` covers the registered packs;
 * this file covers the AST-level extraction strategies the bulk-translation
 * pass relies on (inline arrays, identifier references, spread elements).
 *
 * The extractor is a `.mjs` module that depends on `ts-morph`. We invoke it
 * via the same CLI surface the bulk pass uses (`--dry-run` mode skips the
 * Cerebras call), parse the rendered output, and assert on the registry
 * entries — that's the contract that ships, so it's the contract we test.
 *
 * See the script's top-of-file docstring for the strategy ordering.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, "fixtures", "translate-action-examples");
const elizaRoot = path.resolve(here, "..", "..", "..");
const scriptPath = path.resolve(
  here,
  "..",
  "scripts",
  "translate-action-examples.mjs",
);

function locateBun(): string {
  const candidates = [
    process.env.BUN_INSTALL
      ? path.join(process.env.BUN_INSTALL, "bin", "bun")
      : null,
    // The user's real home — vitest overrides HOME but keeps SUDO_USER /
    // USER to look up the original.
    process.env.USER
      ? path.join("/Users", process.env.USER, ".bun", "bin", "bun")
      : null,
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
    path.join(os.homedir(), ".bun", "bin", "bun"),
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // ignore — try next.
    }
  }
  throw new Error(
    `Could not locate bun binary; tried: ${candidates.join(", ")}`,
  );
}

interface ExtractedEntry {
  exampleKey: string;
  user: { name: string; content: { text: string; actions?: string[] } };
  agent: { name: string; content: { text: string; actions?: string[] } };
}

/**
 * Run the harness against a fixture file in dry-run mode and parse the
 * generated registry pack. Returns the action name + entries plus the raw
 * stderr so failures surface the exact ts-morph diagnostic.
 */
function runHarness(fixture: string): {
  actionName: string;
  entries: ExtractedEntry[];
  stderr: string;
} {
  const fixturePath = path.join(fixtureDir, fixture);
  // Use bun to invoke the harness so ts-morph resolves through the workspace
  // bun store (ts-morph is transitively installed; never declared as a
  // direct dep of any package, so plain `node` import resolution fails).
  // Vitest's setup files override HOME with a sandboxed tmpdir, so we can't
  // rely on `~/.bun/bin/bun`. Probe known locations.
  const bunBinary = locateBun();
  const result = spawnSync(
    bunBinary,
    [
      scriptPath,
      fixturePath,
      "--target-locale=es",
      "--dry-run",
      "--max-examples=10",
    ],
    {
      cwd: elizaRoot,
      encoding: "utf8",
      env: { ...process.env },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Harness exited with status ${result.status}, error=${result.error?.message ?? "<none>"}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  const stdout = result.stdout;
  // Parse the rendered TS file body. The generator emits a comment header
  // with `// action: <NAME>` plus a const literal we can JSON-evaluate
  // after a couple of trivial substitutions.
  const actionMatch = stdout.match(/^\/\/ action: (.+)$/m);
  if (!actionMatch) {
    throw new Error(
      `Could not locate action name in harness output:\n${stdout}\n${result.stderr}`,
    );
  }
  const actionName = actionMatch[1]!.trim();
  const arrayBodyMatch = stdout.match(
    /export const \w+: ReadonlyArray<PromptExampleEntry> = (\[[\s\S]*?\n\]);/,
  );
  if (!arrayBodyMatch) {
    throw new Error(
      `Could not locate generated array literal in harness output:\n${stdout}`,
    );
  }
  // Convert the TS object literal to JSON: drop trailing commas, quote
  // unquoted keys.
  const jsLiteral = arrayBodyMatch[1]!;
  // The harness emits valid JSON-shaped object literals with quoted keys via
  // `JSON.stringify` on every value; the only TS-isms are unquoted property
  // keys and trailing commas. Convert to JSON.
  const jsonLike = jsLiteral
    .replace(/,(\s*[\]}])/g, "$1") // trailing commas
    .replace(
      /(\b)(exampleKey|locale|user|agent|name|content|text|actions|action)(\s*):/g,
      '$1"$2"$3:',
    );
  const entries = JSON.parse(jsonLike) as ExtractedEntry[];
  return { actionName, entries, stderr: result.stderr };
}

describe("translate-action-examples — extractor strategies", () => {
  it("extracts inline `examples: [[...]] as ActionExample[][]` (regression)", () => {
    const { actionName, entries } = runHarness("inline-array.action.ts");
    expect(actionName).toBe("FIXTURE_INLINE");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.user.content.text).toContain(
      "play the strokes first single",
    );
    expect(entries[1]?.agent.content.text).toContain("Finding radiohead!");
    expect(entries[0]?.agent.content.actions).toEqual(["FIXTURE_INLINE"]);
  });

  it("resolves `examples: SOMETHING_EXAMPLES` identifier reference", () => {
    const { actionName, entries } = runHarness("identifier-ref.action.ts");
    expect(actionName).toBe("FIXTURE_IDENTIFIER");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.user.content.text).toContain("queue some 80s synth pop");
    expect(entries[1]?.agent.content.text).toContain(
      "Currently playing: Strokes - Last Nite",
    );
    expect(entries[1]?.agent.content.actions).toEqual(["FIXTURE_IDENTIFIER"]);
  });

  it("concatenates `[...A, ...B.examples ?? [], inlinePair]` spread elements", () => {
    const { actionName, entries } = runHarness("spread-elements.action.ts");
    expect(actionName).toBe("FIXTURE_SPREAD");
    // 1 from fixtureSpreadSourceExamples + 1 from fixtureSpreadAction.examples
    // + 1 inline literal pair = 3 total.
    expect(entries).toHaveLength(3);
    const texts = entries.map((e) => e.user.content.text);
    expect(texts[0]).toContain("library: search for radiohead");
    expect(texts[1]).toContain("library: list playlists");
    expect(texts[2]).toContain("umbrella: do the thing");
  });

  it("preserves source-pair index ordering after spread concatenation", () => {
    const { entries } = runHarness("spread-elements.action.ts");
    // The composite-key contract is `<actionName>.example.<index>`. Spread
    // resolution must produce stable, monotonically-increasing indices so
    // re-runs of the harness don't shuffle locale entries.
    const indices = entries.map((e) =>
      Number(e.exampleKey.split(".example.")[1]),
    );
    expect(indices).toEqual([0, 1, 2]);
  });

  it("fails loud with a source location when an unresolvable identifier is encountered", () => {
    // CLAUDE.md no-silent-fallback rule: when extraction can't reduce to a
    // concrete array literal, the harness must exit non-zero with a
    // diagnostic that points at the offending node.
    const fixturePath = path.join(
      fixtureDir,
      "unresolvable-identifier.action.ts",
    );
    const result = spawnSync(
      locateBun(),
      [
        scriptPath,
        fixturePath,
        "--target-locale=es",
        "--dry-run",
        "--max-examples=1",
      ],
      {
        cwd: elizaRoot,
        encoding: "utf8",
        env: { ...process.env },
      },
    );
    expect(result.status).not.toBe(0);
    const errOutput = `${result.stdout}\n${result.stderr}`;
    // The harness fails loud either at identifier resolution (when the
    // identifier maps to nothing) or at the unsupported-initializer step
    // (when it maps to a non-array shape such as a CallExpression). Both
    // are valid no-silent-fallback paths; assert the diagnostic points at
    // the source location.
    expect(errOutput).toMatch(
      /Unsupported initializer kind|Could not resolve identifier/i,
    );
    expect(errOutput).toContain("unresolvable-identifier.action.ts");
  });
});
