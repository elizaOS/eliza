/**
 * Verifies resolveSpawnWorkdir — explicit workdir fallback.
 * Runs against a real temporary filesystem with a stubbed runtime; no live model.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeTaskAgentAdapter,
  resolvePinnedAdapter,
  resolveSpawnWorkdir,
  resolveWorkdirByConvention,
  resolveWorkdirRoute,
} from "../../src/services/task-agent-routing.js";

// `task` / `userRequest` are deliberately chosen so they match no configured
// `TASK_AGENT_WORKDIR_ROUTES` route — these tests exercise the explicit-workdir
// fallback path (steps 3-4), not route resolution.
const NO_ROUTE_TASK = "do the unremarkable thing";

describe("resolveSpawnWorkdir — explicit workdir fallback", () => {
  it("trusts an explicit workdir that exists on disk", () => {
    const existing = os.tmpdir();
    expect(
      resolveSpawnWorkdir(undefined, NO_ROUTE_TASK, NO_ROUTE_TASK, existing),
    ).toEqual({ workdir: existing });
  });

  it("ignores a typo'd explicit workdir that does not exist, falling back to cwd", () => {
    const missing = path.join(
      os.tmpdir(),
      "planner-workdir-typo-does-not-exist",
    );
    const result = resolveSpawnWorkdir(
      undefined,
      NO_ROUTE_TASK,
      NO_ROUTE_TASK,
      missing,
    );
    expect(result).toEqual({ workdir: process.cwd() });
  });

  it("falls back to cwd when no workdir is supplied at all", () => {
    expect(
      resolveSpawnWorkdir(undefined, NO_ROUTE_TASK, NO_ROUTE_TASK, undefined),
    ).toEqual({ workdir: process.cwd() });
  });

  it("ignores a locked workdir that does not exist", () => {
    // `lockWorkdir` is only trusted after a scaffold-aware caller has created
    // the exact target directory. Planner-guessed typo paths must still fall
    // through to route/default resolution.
    const locked = path.join(
      os.tmpdir(),
      "planner-workdir-typo-does-not-exist",
    );
    expect(
      resolveSpawnWorkdir(undefined, NO_ROUTE_TASK, NO_ROUTE_TASK, locked, {
        lockWorkdir: true,
      }),
    ).toEqual({ workdir: process.cwd() });
  });
});

describe("resolveSpawnWorkdir — configured workspace root fallback", () => {
  // When a task matches no route/convention/explicit workdir, the last resort
  // honors the documented ACP workspace settings (so simple tasks don't write
  // into the runtime's own source checkout), falling back to process.cwd()
  // only when neither is set — preserving the self-checkout default.
  const stubRuntime = (settings: Record<string, string>) =>
    ({ getSetting: (key: string) => settings[key] }) as never;

  it("honors ELIZA_ACP_WORKSPACE_ROOT over process.cwd() when no route matches", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-root-"));
    expect(
      resolveSpawnWorkdir(
        stubRuntime({ ELIZA_ACP_WORKSPACE_ROOT: root }),
        NO_ROUTE_TASK,
        NO_ROUTE_TASK,
        undefined,
      ),
    ).toEqual({ workdir: root, isolate: true });
  });

  it("ignores planner-guessed runtime cwd when a workspace root is configured", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-root-"));
    expect(
      resolveSpawnWorkdir(
        stubRuntime({ ELIZA_ACP_WORKSPACE_ROOT: root }),
        NO_ROUTE_TASK,
        NO_ROUTE_TASK,
        process.cwd(),
      ),
    ).toEqual({ workdir: root, isolate: true });
  });

  it("honors ACPX_DEFAULT_CWD when ELIZA_ACP_WORKSPACE_ROOT is unset", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-cwd-"));
    expect(
      resolveSpawnWorkdir(
        stubRuntime({ ACPX_DEFAULT_CWD: root }),
        NO_ROUTE_TASK,
        NO_ROUTE_TASK,
        undefined,
      ),
    ).toEqual({ workdir: root, isolate: true });
  });

  it("prefers ELIZA_ACP_WORKSPACE_ROOT over ACPX_DEFAULT_CWD", () => {
    const preferred = fs.mkdtempSync(path.join(os.tmpdir(), "ws-pref-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "ws-other-"));
    expect(
      resolveSpawnWorkdir(
        stubRuntime({
          ELIZA_ACP_WORKSPACE_ROOT: preferred,
          ACPX_DEFAULT_CWD: other,
        }),
        NO_ROUTE_TASK,
        NO_ROUTE_TASK,
        undefined,
      ),
    ).toEqual({ workdir: preferred, isolate: true });
  });

  it("still returns process.cwd() when no workspace root is configured (self-checkout default)", () => {
    expect(
      resolveSpawnWorkdir(
        stubRuntime({}),
        NO_ROUTE_TASK,
        NO_ROUTE_TASK,
        undefined,
      ),
    ).toEqual({ workdir: process.cwd() });
  });
});

describe("resolveDefaultSpawnWorkdir — full setting precedence", () => {
  // The last-resort default-spawn workdir reads, in order, the runtime settings
  // ELIZA_ACP_WORKSPACE_ROOT > ACPX_DEFAULT_CWD > ELIZA_WORKSPACE_DIR >
  // ELIZA_CODING_WORKSPACE > ELIZA_CODING_DIRECTORY, then the equivalent
  // config-env keys, then process.cwd(). Exercised through resolveSpawnWorkdir's
  // no-route/no-explicit fallback path. Pin TASK_AGENT_WORKDIR_ROOTS to an empty
  // dir so the convention scan never short-circuits before the default.
  const stubRuntime = (settings: Record<string, string>) =>
    ({ getSetting: (key: string) => settings[key] }) as never;

  let emptyRoots: string;
  const previousRoots = process.env.TASK_AGENT_WORKDIR_ROOTS;

  beforeEach(() => {
    emptyRoots = fs.mkdtempSync(path.join(os.tmpdir(), "no-convention-"));
    process.env.TASK_AGENT_WORKDIR_ROOTS = emptyRoots;
  });

  afterEach(() => {
    if (previousRoots === undefined)
      delete process.env.TASK_AGENT_WORKDIR_ROOTS;
    else process.env.TASK_AGENT_WORKDIR_ROOTS = previousRoots;
    fs.rmSync(emptyRoots, { recursive: true, force: true });
  });

  const resolveDefault = (settings: Record<string, string>) =>
    resolveSpawnWorkdir(
      stubRuntime(settings),
      NO_ROUTE_TASK,
      NO_ROUTE_TASK,
      undefined,
    );

  it("honors ELIZA_WORKSPACE_DIR when the ACP-specific roots are unset", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-dir-"));
    expect(resolveDefault({ ELIZA_WORKSPACE_DIR: dir })).toEqual({
      workdir: dir,
      isolate: true,
    });
  });

  it("honors ELIZA_CODING_WORKSPACE when higher-precedence keys are unset", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-ws-"));
    expect(resolveDefault({ ELIZA_CODING_WORKSPACE: dir })).toEqual({
      workdir: dir,
      isolate: true,
    });
  });

  it("honors ELIZA_CODING_DIRECTORY when higher-precedence keys are unset (WorkspaceService parity)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-dir-"));
    expect(resolveDefault({ ELIZA_CODING_DIRECTORY: dir })).toEqual({
      workdir: dir,
      isolate: true,
    });
  });

  it("applies the full precedence order ACP_ROOT > ACPX > WORKSPACE_DIR > CODING_WORKSPACE > CODING_DIRECTORY", () => {
    const acpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p-acproot-"));
    const acpxCwd = fs.mkdtempSync(path.join(os.tmpdir(), "p-acpx-"));
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-wsdir-"));
    const codingWs = fs.mkdtempSync(path.join(os.tmpdir(), "p-codingws-"));
    const codingDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-codingdir-"));

    const all = {
      ELIZA_ACP_WORKSPACE_ROOT: acpRoot,
      ACPX_DEFAULT_CWD: acpxCwd,
      ELIZA_WORKSPACE_DIR: workspaceDir,
      ELIZA_CODING_WORKSPACE: codingWs,
      ELIZA_CODING_DIRECTORY: codingDir,
    };

    // Peel keys off one at a time; each step's top-most remaining key wins.
    expect(resolveDefault(all).workdir).toBe(acpRoot);
    const { ELIZA_ACP_WORKSPACE_ROOT: _a, ...noAcpRoot } = all;
    expect(resolveDefault(noAcpRoot).workdir).toBe(acpxCwd);
    const { ACPX_DEFAULT_CWD: _b, ...noAcpx } = noAcpRoot;
    expect(resolveDefault(noAcpx).workdir).toBe(workspaceDir);
    const { ELIZA_WORKSPACE_DIR: _c, ...noWsDir } = noAcpx;
    expect(resolveDefault(noWsDir).workdir).toBe(codingWs);
    const { ELIZA_CODING_WORKSPACE: _d, ...onlyCodingDir } = noWsDir;
    expect(resolveDefault(onlyCodingDir).workdir).toBe(codingDir);
  });
});

describe("resolveWorkdirByConvention", () => {
  // Each test gets a fresh isolated root so parallel runs and leftover state
  // from prior runs cannot contaminate the directory scan.
  let root: string;
  const previousRoots = process.env.TASK_AGENT_WORKDIR_ROOTS;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "workdir-convention-"));
    process.env.TASK_AGENT_WORKDIR_ROOTS = root;
  });

  afterEach(() => {
    if (previousRoots === undefined)
      delete process.env.TASK_AGENT_WORKDIR_ROOTS;
    else process.env.TASK_AGENT_WORKDIR_ROOTS = previousRoots;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns the matching project dir when its name appears in the user request", () => {
    fs.mkdirSync(path.join(root, "camping-car-europe"));
    fs.mkdirSync(path.join(root, "unrelated-project"));
    expect(
      resolveWorkdirByConvention(
        undefined,
        "build a thing",
        "let's ship camping car europe today",
      ),
    ).toBe(path.join(root, "camping-car-europe"));
  });

  it("returns undefined when no project dir name appears in the request", () => {
    fs.mkdirSync(path.join(root, "boseti"));
    fs.mkdirSync(path.join(root, "soulmates"));
    expect(
      resolveWorkdirByConvention(
        undefined,
        "build a thing",
        "do something generic",
      ),
    ).toBeUndefined();
  });

  it("falls back to undefined when multiple project dirs match (ambiguous)", () => {
    fs.mkdirSync(path.join(root, "boseti"));
    fs.mkdirSync(path.join(root, "soulmates"));
    expect(
      resolveWorkdirByConvention(
        undefined,
        "ship boseti and soulmates together",
        "ship boseti and soulmates together",
      ),
    ).toBeUndefined();
  });
});

describe("resolveWorkdirRoute — malformed route guard", () => {
  const stubRuntime = (routesJson: string) =>
    ({
      getSetting: (key: string) =>
        key === "TASK_AGENT_WORKDIR_ROUTES" ? routesJson : undefined,
    }) as never;

  it("drops a route whose match fields are not arrays instead of throwing", () => {
    // `matchAll: "foo"` (string, misconfigured) would otherwise reach
    // routeMatches()'s `.some()` and throw "some is not a function". The parse
    // guard must filter the entry out so resolution degrades to no-match.
    const routes = JSON.stringify([
      { id: "bad", workdir: os.tmpdir(), matchAll: "foo" },
    ]);
    expect(() =>
      resolveWorkdirRoute(stubRuntime(routes), "task", "ship foo now"),
    ).not.toThrow();
    expect(
      resolveWorkdirRoute(stubRuntime(routes), "task", "ship foo now"),
    ).toBeUndefined();
  });

  it("still matches a well-formed array route", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-ok-"));
    const routes = JSON.stringify([
      { id: "ok", workdir: dir, matchAny: ["shipit"] },
    ]);
    const r = resolveWorkdirRoute(stubRuntime(routes), "task", "please shipit");
    expect(r?.id).toBe("ok");
    expect(r?.workdir).toBe(dir);
  });
});

describe("task-agent adapter aliases", () => {
  it("keeps benchmark elizaOS aliases as first-class adapters", () => {
    expect(normalizeTaskAgentAdapter("elizaos")).toBe("elizaos");
    expect(normalizeTaskAgentAdapter("eliza")).toBe("elizaos");
    expect(normalizeTaskAgentAdapter("pi-agent")).toBe("pi-agent");
    expect(normalizeTaskAgentAdapter("pi")).toBe("pi-agent");
    expect(normalizeTaskAgentAdapter("claude-code")).toBe("claude");
    expect(normalizeTaskAgentAdapter("openai-codex")).toBe("codex");
  });

  it("uses BENCHMARK_TASK_AGENT as a fixed orchestrator pin", () => {
    const runtime = {
      getSetting: (key: string) =>
        key === "BENCHMARK_TASK_AGENT" ? "elizaos" : undefined,
    };
    expect(resolvePinnedAdapter(runtime as never)).toBe("elizaos");
  });

  it("lets BENCHMARK_TASK_AGENT override stale default-agent settings", () => {
    const runtime = {
      getSetting: (key: string) =>
        key === "BENCHMARK_TASK_AGENT"
          ? "elizaos"
          : key === "ELIZA_DEFAULT_AGENT_TYPE"
            ? "codex"
            : undefined,
    };
    expect(resolvePinnedAdapter(runtime as never)).toBe("elizaos");
  });
});
