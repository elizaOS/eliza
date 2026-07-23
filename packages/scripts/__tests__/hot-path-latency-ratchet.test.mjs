/**
 * Verifies the hot-path latency ratchet: classifier fixtures (a provider that
 * adds a bare awaited fetch is flagged; the same provider wrapped in
 * ctx.waitUntil or annotated `// latency-ok:` passes), the diff-scoped
 * comparison, and an end-to-end run against a real throwaway git repo via
 * HOT_PATH_LATENCY_ROOT / HOT_PATH_LATENCY_BASE_REF. No mocks — the e2e cases
 * spawn the actual script against actual git history.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  changedProductionFiles,
  collectFindings,
  compareFileCounts,
  countText,
  diffScopedRegressions,
  mergeBaseWith,
  repoWideTotals,
  resolveBaseRef,
  runSelfTest,
} from "../hot-path-latency-ratchet.mjs";

const SCRIPT = resolve(import.meta.dirname, "../hot-path-latency-ratchet.mjs");
const PROVIDER_PATH = "packages/foo/src/providers/facts.ts";

// Generous timeout for cases that shell out to real git / spawn node: fast on
// CI, but cold process spawns can exceed bun's 5s default on AV-scanned dev
// boxes (notably Windows).
const GIT_TEST_TIMEOUT_MS = 60000;

const repos = [];
afterAll(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function write(cwd, path, contents) {
  const fullPath = join(cwd, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
}

function provider(body) {
  return `import type { Provider } from "@elizaos/core";
export const factsProvider: Provider = {
  name: "FACTS",
  get: async (runtime, message, state, ctx) => {
${body}
  },
};
`;
}

const CLEAN_BODY = `    return { text: "static" };`;
const BARE_FETCH_BODY = `    const res = await fetch("https://example.com/facts");
    return { text: String(res) };`;
const WAIT_UNTIL_BODY = `    ctx.waitUntil((async () => {
      const res = await fetch("https://example.com/facts");
      void res;
    })());
    return { text: "static" };`;
const ANNOTATED_BODY = `    // latency-ok: cold-start only, cached for the session
    const res = await fetch("https://example.com/facts");
    return { text: String(res) };`;

describe("classifier fixtures", () => {
  it("flags a provider get() that adds a bare await fetch", () => {
    const counts = countText(provider(BARE_FETCH_BODY), PROVIDER_PATH);
    expect(counts.providerHotAwait).toBe(1);
    expect(counts.manifestHotAwait).toBe(0);
  });

  it("passes the same provider when the fetch is wrapped in ctx.waitUntil", () => {
    const counts = countText(provider(WAIT_UNTIL_BODY), PROVIDER_PATH);
    expect(counts.providerHotAwait).toBe(0);
  });

  it("passes the same provider when the line carries // latency-ok:", () => {
    const counts = countText(provider(ANNOTATED_BODY), PROVIDER_PATH);
    expect(counts.providerHotAwait).toBe(0);
  });

  it("does not let a balanced sibling waitUntil() sanction a later bare await", () => {
    const body = `    ctx.waitUntil(warm(runtime));
    const res = await fetch("https://example.com/facts");
    return { text: String(res) };`;
    expect(countText(provider(body), PROVIDER_PATH).providerHotAwait).toBe(1);
  });

  it("ignores non-awaited fire-and-forget and Promise.race shapes", () => {
    const body = `    void fetch("https://example.com").catch(() => undefined);
    const res = await Promise.race([fetch("https://example.com"), deadline(800)]);
    return { text: String(res) };`;
    expect(countText(provider(body), PROVIDER_PATH).providerHotAwait).toBe(0);
  });

  it("sanctions a provider that declares a timeoutMs budget", () => {
    const src = `export const factsProvider: Provider = {
  timeoutMs: 500,
  get: async (runtime, message, state) => {
    const res = await fetch("https://example.com/facts");
    return { text: String(res) };
  },
};
`;
    expect(countText(src, PROVIDER_PATH).providerHotAwait).toBe(0);
  });

  it("sanctions an await behind a cache-hit guard in the same body", () => {
    const body = `    const cached = await runtime.getCache("facts");
    if (cached) return { text: cached };
    const res = await fetch("https://example.com/facts");
    return { text: String(res) };`;
    expect(countText(provider(body), PROVIDER_PATH).providerHotAwait).toBe(0);
  });

  it("flags awaited DB reads and useModel in manifest turn-serving files", () => {
    const src = `export class MessageService {
  async handle(runtime, message) {
    return await this.runtime.useModel(ModelType.TEXT_LARGE, {});
  }
}
`;
    const manifest = countText(src, "packages/core/src/services/message.ts");
    expect(manifest.manifestHotAwait).toBe(1);
    // Identical content at a non-manifest path stays out of scope.
    const elsewhere = countText(src, "packages/foo/src/services/message.ts");
    expect(elsewhere.manifestHotAwait).toBe(0);
  });

  it("scopes runtime.ts to the composeState body only", () => {
    const src = `export class AgentRuntime {
  async other() {
    return await fetch("https://example.com");
  }
  async composeState(message, includeList) {
    return await this.getMemories({ roomId: message.roomId });
  }
}
`;
    const counts = countText(src, "packages/core/src/runtime.ts");
    expect(counts.manifestHotAwait).toBe(1);
    const findings = collectFindings(src, "packages/core/src/runtime.ts");
    expect(findings[0].line).toBe(6);
  });
});

describe("diff-scoped comparison", () => {
  it("regresses only on an increase over the file's own base count", () => {
    const same = compareFileCounts(
      { providerHotAwait: 2, manifestHotAwait: 0 },
      { providerHotAwait: 2, manifestHotAwait: 0 },
    );
    expect(same).toEqual([]);
    const added = compareFileCounts(
      { providerHotAwait: 3, manifestHotAwait: 0 },
      { providerHotAwait: 2, manifestHotAwait: 0 },
    );
    expect(added).toEqual([{ kind: "providerHotAwait", current: 3, base: 2 }]);
    const removed = compareFileCounts(
      { providerHotAwait: 1, manifestHotAwait: 0 },
      { providerHotAwait: 2, manifestHotAwait: 0 },
    );
    expect(removed).toEqual([]);
  });
});

describe("script modes", () => {
  it(
    "--self-test passes",
    () => {
      const result = spawnSync("node", [SCRIPT, "--self-test"], {
        encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("self-test passed");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it("runs the self-test fixtures in-process (instrumented for coverage)", () => {
    expect(() => runSelfTest()).not.toThrow();
  });
});

function makeRepo(baseBody) {
  const repo = mkdtempSync(join(tmpdir(), "hot-path-ratchet-"));
  repos.push(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  git(repo, "checkout", "-q", "-b", "develop");
  write(repo, PROVIDER_PATH, provider(baseBody));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  return repo;
}

function runRatchet(repo, extraArgs = []) {
  return spawnSync("node", [SCRIPT, ...extraArgs], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOT_PATH_LATENCY_ROOT: repo,
      HOT_PATH_LATENCY_BASE_REF: "develop",
    },
  });
}

describe("end-to-end against real git history", () => {
  it(
    "fails when a touched provider adds a bare awaited fetch",
    () => {
      const repo = makeRepo(CLEAN_BODY);
      write(repo, PROVIDER_PATH, provider(BARE_FETCH_BODY));
      git(repo, "commit", "-aqm", "add bare fetch");
      const result = runRatchet(repo);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Provider get() body");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "passes when the added fetch is waitUntil-wrapped or annotated",
    () => {
      for (const body of [WAIT_UNTIL_BODY, ANNOTATED_BODY]) {
        const repo = makeRepo(CLEAN_BODY);
        write(repo, PROVIDER_PATH, provider(body));
        git(repo, "commit", "-aqm", "sanctioned change");
        const result = runRatchet(repo);
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      }
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "passes a touched file whose pre-existing hot await is unchanged",
    () => {
      const repo = makeRepo(BARE_FETCH_BODY);
      write(
        repo,
        PROVIDER_PATH,
        provider(BARE_FETCH_BODY).replace('name: "FACTS"', 'name: "FACTS2"'),
      );
      git(repo, "commit", "-aqm", "unrelated edit");
      const result = runRatchet(repo);
      expect(result.status).toBe(0);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "passes (skips) when no base ref resolves",
    () => {
      // Repo with only a `main` branch: origin/develop and develop are both
      // unresolvable, so the guard must skip and pass.
      const repo = mkdtempSync(join(tmpdir(), "hot-path-ratchet-nobase-"));
      repos.push(repo);
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "test@example.com");
      git(repo, "config", "user.name", "test");
      write(repo, PROVIDER_PATH, provider(BARE_FETCH_BODY));
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "base");
      const env = { ...process.env, HOT_PATH_LATENCY_ROOT: repo };
      delete env.HOT_PATH_LATENCY_BASE_REF;
      const result = spawnSync("node", [SCRIPT], { encoding: "utf8", env });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("skipped (pass)");
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "reports counts with --json",
    () => {
      const repo = makeRepo(CLEAN_BODY);
      write(repo, PROVIDER_PATH, provider(BARE_FETCH_BODY));
      git(repo, "commit", "-aqm", "add bare fetch");
      const result = runRatchet(repo, ["--json"]);
      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.regressions).toEqual([
        {
          file: PROVIDER_PATH,
          kind: "providerHotAwait",
          current: 1,
          base: 0,
        },
      ]);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

/**
 * Run `fn` with the script's env knobs pointed at `repo`, restoring the
 * previous values afterwards. The git plumbing resolves its root lazily, so
 * direct imported calls (instrumented for coverage) hit the throwaway repo.
 */
function withRepoEnv(repo, fn) {
  const prevRoot = process.env.HOT_PATH_LATENCY_ROOT;
  const prevBase = process.env.HOT_PATH_LATENCY_BASE_REF;
  process.env.HOT_PATH_LATENCY_ROOT = repo;
  process.env.HOT_PATH_LATENCY_BASE_REF = "develop";
  try {
    return fn();
  } finally {
    if (prevRoot === undefined) delete process.env.HOT_PATH_LATENCY_ROOT;
    else process.env.HOT_PATH_LATENCY_ROOT = prevRoot;
    if (prevBase === undefined) delete process.env.HOT_PATH_LATENCY_BASE_REF;
    else process.env.HOT_PATH_LATENCY_BASE_REF = prevBase;
  }
}

describe("git plumbing via direct import (instrumented)", () => {
  it(
    "resolves base ref, merge-base, changed files, and regressions against a real repo",
    () => {
      const repo = makeRepo(CLEAN_BODY);
      write(repo, PROVIDER_PATH, provider(BARE_FETCH_BODY));
      git(repo, "commit", "-aqm", "add bare fetch");
      withRepoEnv(repo, () => {
        const baseRef = resolveBaseRef();
        expect(baseRef).toBe("develop");
        const base = mergeBaseWith(baseRef);
        expect(base).toMatch(/^[0-9a-f]{40}$/);
        const files = changedProductionFiles(base);
        expect(files).toEqual([PROVIDER_PATH]);
        const { perFile, regressions } = diffScopedRegressions(base, files);
        expect(perFile).toEqual([
          {
            file: PROVIDER_PATH,
            current: { providerHotAwait: 1, manifestHotAwait: 0 },
            base: { providerHotAwait: 0, manifestHotAwait: 0 },
          },
        ]);
        expect(regressions).toEqual([
          {
            file: PROVIDER_PATH,
            kind: "providerHotAwait",
            current: 1,
            base: 0,
          },
        ]);
      });
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "reports no regressions for a sanctioned (annotated) change",
    () => {
      const repo = makeRepo(CLEAN_BODY);
      write(repo, PROVIDER_PATH, provider(ANNOTATED_BODY));
      git(repo, "commit", "-aqm", "annotated change");
      withRepoEnv(repo, () => {
        const base = mergeBaseWith(resolveBaseRef());
        const { regressions } = diffScopedRegressions(
          base,
          changedProductionFiles(base),
        );
        expect(regressions).toEqual([]);
      });
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    "computes repo-wide informational totals over tracked production files",
    () => {
      const repo = makeRepo(BARE_FETCH_BODY);
      withRepoEnv(repo, () => {
        const totals = repoWideTotals();
        expect(totals.filesScanned).toBe(1);
        expect(totals.counts).toEqual({
          providerHotAwait: 1,
          manifestHotAwait: 0,
        });
      });
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
