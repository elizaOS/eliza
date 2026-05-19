import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeTaskAgentAdapter,
  resolvePinnedAdapter,
  resolveSpawnWorkdir,
  resolveWorkdirByConvention,
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
