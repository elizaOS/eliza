/**
 * Verifies that convention workdir detection (TASK_AGENT_WORKDIR_ROOTS) matches
 * a project directory name only as a whole phrase in the request, the same
 * rule configured routes use.
 * Runs against a real temporary filesystem; deterministic.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveSpawnWorkdir,
  resolveWorkdirByConvention,
} from "../services/task-agent-routing.js";

const ENV_KEYS = [
  "TASK_AGENT_WORKDIR_ROOTS",
  "TASK_AGENT_WORKDIR_ROUTES",
  "ELIZA_CONFIG_PATH",
  "ELIZA_ACP_WORKSPACE_ROOT",
] as const;

let saved: Record<string, string | undefined>;
let tmpRoot: string;
let projectsDir: string;
let scratchDir: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workdir-convention-"));
  projectsDir = path.join(tmpRoot, "projects");
  scratchDir = path.join(tmpRoot, "scratch");
  fs.mkdirSync(path.join(projectsDir, "site"), { recursive: true });
  fs.mkdirSync(path.join(projectsDir, "camping-car-europe"), {
    recursive: true,
  });
  fs.mkdirSync(scratchDir, { recursive: true });
  process.env.TASK_AGENT_WORKDIR_ROOTS = projectsDir;
  delete process.env.TASK_AGENT_WORKDIR_ROUTES;
  // Point the config file at a missing path so only the env above applies.
  process.env.ELIZA_CONFIG_PATH = path.join(tmpRoot, "missing-config.json");
  process.env.ELIZA_ACP_WORKSPACE_ROOT = scratchDir;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveWorkdirByConvention", () => {
  it("matches a project the request names", () => {
    const request = "Fix the nav bar in site.";
    expect(resolveWorkdirByConvention(undefined, request, request)).toBe(
      path.join(projectsDir, "site"),
    );
  });

  it("matches a hyphenated project named with spaces or by its path", () => {
    expect(
      resolveWorkdirByConvention(
        undefined,
        "Add a packing list to the camping car europe planner",
        "Add a packing list to the camping car europe planner",
      ),
    ).toBe(path.join(projectsDir, "camping-car-europe"));
    expect(
      resolveWorkdirByConvention(
        undefined,
        "Run the tests in ~/projects/camping-car-europe/app",
        "Run the tests in ~/projects/camping-car-europe/app",
      ),
    ).toBe(path.join(projectsDir, "camping-car-europe"));
  });

  it("does not match a project whose name is only part of a longer word", () => {
    for (const request of [
      "Build me a website for my bakery",
      "Summarize the campsite reviews",
    ]) {
      expect(resolveWorkdirByConvention(undefined, request, request)).toBe(
        undefined,
      );
    }
  });
});

describe("resolveSpawnWorkdir with convention roots", () => {
  it("spawns a new website request in the scratch root, not in the `site` project", () => {
    const request = "Build me a website for my bakery";
    expect(resolveSpawnWorkdir(undefined, request, request, undefined)).toEqual(
      { workdir: scratchDir, isolate: true },
    );
  });
});
