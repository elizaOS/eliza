/**
 * Mutation-sensitive source-authority gate for the bundled runtime skill docs
 * (#19479 review). These markdown files are injected into agent system
 * prompts, so a repository path or root command they cite is a runtime
 * instruction, not prose. Every backtick-quoted `packages/`, `plugins/`, or
 * `scripts/` reference must exist in the tree (globs must resolve against a
 * real static prefix); the pre-consolidation layout roots `apps/`, `cloud/`,
 * and `eliza/` are always invalid; and every cited `bun run <script>` must
 * exist in a workspace manifest. Real filesystem and manifests — no fixtures.
 */

import assert from "node:assert";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SKILLS_ROOT = join(REPO_ROOT, "packages/skills/skills");

interface AllowlistEntry {
  doc: string;
  ref: string;
  reason: string;
}

/**
 * Exact (doc, token) pairs the gate skips, each with a durable reason.
 * Entries are tolerated when already repaired so concurrent-PR merge order
 * can never redden the lane; remove them opportunistically.
 */
const ALLOWLIST: AllowlistEntry[] = [
  {
    doc: "eliza-cloud/references/cloud-backend-and-monetization.md",
    ref: "packages/cloud/shared/src/db/schemas/app-billing.ts",
    reason:
      "repaired in #19455 (repointed to payment-requests.ts); tolerated until that PR merges",
  },
  {
    doc: "eliza-cloud/references/cloud-backend-and-monetization.md",
    ref: "packages/cloud-frontend/src/pages/login",
    reason:
      "repaired in #19455 (repointed to packages/ui public pages); tolerated until that PR merges",
  },
  {
    doc: "skill-creator/SKILL.md",
    ref: "scripts/rotate_pdf.py",
    reason:
      "illustrative example of a skill-local scripts/ file in the skill-authoring guide, not a repository path",
  },
];

const OBSOLETE_ROOTS = ["apps/", "cloud/", "eliza/"];
const ENFORCED_ROOTS = ["packages/", "plugins/", "scripts/"];

const PATH_TOKEN = /`([A-Za-z0-9_@.[\]*-]+(?:\/[A-Za-z0-9_@.[\]*-]+)+)\/?`/g;
// Single-segment tokens like `cloud/` never match PATH_TOKEN (it requires two
// segments), so the obsolete-root ban needs its own scan or the exact tokens
// this gate exists for would slip through. The slash is required so bare
// product-name prose like `eliza` stays out of scope.
const OBSOLETE_TOKEN = /`((?:apps|cloud|eliza)\/[A-Za-z0-9_@.[\]*/-]*)`/g;
const RUN_TOKEN =
  /\bbun run\s+((?:--?[A-Za-z-]+(?:[= ][^\s`]+)?\s+)*)([A-Za-z0-9:._-]+)/g;

function allowlisted(doc: string, ref: string): boolean {
  return ALLOWLIST.some((entry) => entry.doc === doc && entry.ref === ref);
}

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listMarkdown(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

function trailingGlobMatches(ref: string): boolean {
  const parts = ref.split("/");
  const last = parts.pop() ?? "";
  const parent = join(REPO_ROOT, parts.join("/"));
  if (!last.endsWith("*") || last.indexOf("*") !== last.length - 1)
    return false;
  if (!existsSync(parent)) return false;
  const prefix = last.slice(0, -1);
  return readdirSync(parent).some((entry) => entry.startsWith(prefix));
}

function globResolves(ref: string): boolean {
  const segments = ref.split("/");
  const firstGlob = segments.findIndex((segment) => segment.includes("*"));
  if (firstGlob === segments.length - 1) return trailingGlobMatches(ref);
  const staticPrefix = segments.slice(0, firstGlob).join("/");
  return staticPrefix.length > 0 && existsSync(join(REPO_ROOT, staticPrefix));
}

function workspaceScripts(): Set<string> {
  const names = new Set<string>();
  const addManifest = (file: string) => {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      scripts?: Record<string, string>;
    };
    for (const name of Object.keys(parsed.scripts ?? {})) names.add(name);
  };
  addManifest(join(REPO_ROOT, "package.json"));
  for (const root of [
    join(REPO_ROOT, "packages"),
    join(REPO_ROOT, "plugins"),
  ]) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const manifest = join(root, entry, "package.json");
      if (existsSync(manifest)) addManifest(manifest);
    }
  }
  return names;
}

describe("bundled skill docs cite real repository authority", () => {
  const docs = listMarkdown(SKILLS_ROOT);
  assert.ok(
    docs.length > 20,
    "expected the bundled skill corpus to be present",
  );
  const scripts = workspaceScripts();

  it("every enforced repository path exists and no obsolete layout root survives", () => {
    const failures: string[] = [];
    for (const doc of docs) {
      const rel = doc.slice(SKILLS_ROOT.length + 1);
      const text = readFileSync(doc, "utf8");
      for (const match of text.matchAll(OBSOLETE_TOKEN)) {
        const ref = match[1].replace(/\/$/, "");
        if (allowlisted(rel, ref)) continue;
        failures.push(
          `${rel}: \`${ref}\` uses a pre-consolidation layout root`,
        );
      }
      for (const match of text.matchAll(PATH_TOKEN)) {
        const ref = match[1];
        if (allowlisted(rel, ref)) continue;
        if (OBSOLETE_ROOTS.some((root) => ref.startsWith(root))) continue;
        if (!ENFORCED_ROOTS.some((root) => ref.startsWith(root))) continue;
        if (ref.includes("*")) {
          if (!globResolves(ref)) {
            failures.push(`${rel}: glob \`${ref}\` matches nothing`);
          }
          continue;
        }
        if (!existsSync(join(REPO_ROOT, ref))) {
          failures.push(`${rel}: \`${ref}\` does not exist in the tree`);
        }
      }
    }
    assert.deepStrictEqual(failures, []);
  });

  it("every cited bun run script exists in a workspace manifest", () => {
    const failures: string[] = [];
    for (const doc of docs) {
      const rel = doc.slice(SKILLS_ROOT.length + 1);
      const text = readFileSync(doc, "utf8");
      for (const match of text.matchAll(RUN_TOKEN)) {
        const name = match[2];
        if (name.endsWith("...") || name === "...") continue;
        if (!scripts.has(name)) {
          failures.push(
            `${rel}: \`bun run ${name}\` matches no workspace manifest script`,
          );
        }
      }
    }
    assert.deepStrictEqual(failures, []);
  });

  it("repaired allowlist entries are surfaced for removal", () => {
    // Informational rather than a throw: entries are deliberately
    // tolerated-when-absent so two in-flight PRs cannot redden each other,
    // but a repaired entry should be deleted on the next touch.
    for (const entry of ALLOWLIST) {
      const text = readFileSync(join(SKILLS_ROOT, entry.doc), "utf8");
      if (
        !text.includes(`\`${entry.ref}\``) &&
        !text.includes(`\`${entry.ref}/\``)
      ) {
        console.warn(
          `[skill-doc-path-authority] allowlist entry repaired; remove it: ${entry.doc} -> ${entry.ref}`,
        );
      }
    }
    assert.ok(true);
  });
});
