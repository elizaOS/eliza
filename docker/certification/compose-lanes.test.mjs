/**
 * Tests for the compose-lane generator (#14549): pure plan→lane derivation and
 * cpuset math against a fixture plan, byte-determinism of the renderer, the
 * committed-compose drift gate (spawns the real generator, which runs the real
 * run-all-tests.mjs --plan=json), and structural validation of the committed
 * file — via a real `docker compose config` when docker is on PATH, else a
 * YAML-parse sanity check (Bun.YAML), stated explicitly in the test output.
 * Run with `bun test docker/certification` (outside workspace discovery, so
 * CI carries an explicit step).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allocateCpusets,
  buildComposeModel,
  DEFAULT_PARAMS,
  deriveLanes,
  escapeComposeValue,
  laneBaseName,
  paramsAreDefault,
  renderCompose,
  resolveParams,
} from "./compose-lanes-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const composePath = path.join(here, "compose.yml");

/** Minimal but shape-faithful --plan=json --all document. */
const fixturePlan = {
  summary: {
    byScript: {
      test: 241,
      "test:e2e": 17,
      "test:live": 1,
      "test:ui": 1,
      "test:integration": 4,
    },
  },
  tasks: [],
  skipped: [],
  cloudStep: { label: "cloud#test", command: "bun run test:cloud" },
};

const fixtureModelSets = {
  ocr: {
    files: { model: { name: "ocr.gguf" }, mmproj: { name: "ocr-mmproj.gguf" } },
  },
  vlm: {
    files: { model: { name: "vlm.gguf" }, mmproj: { name: "vlm-mmproj.gguf" } },
  },
};

describe("laneBaseName", () => {
  test("maps plan scriptNames to lane names", () => {
    expect(laneBaseName("test")).toBe("unit");
    expect(laneBaseName("test:e2e")).toBe("e2e");
    expect(laneBaseName("test:integration")).toBe("integration");
    expect(laneBaseName("test:some odd/Name")).toBe("some-odd-name");
  });
});

describe("deriveLanes", () => {
  test("derives sharded unit/e2e lanes, singleton lanes, and the cloud lane", () => {
    const lanes = deriveLanes(fixturePlan, DEFAULT_PARAMS);
    expect(lanes.map((lane) => lane.name)).toEqual([
      "unit-1of4",
      "unit-2of4",
      "unit-3of4",
      "unit-4of4",
      "e2e-1of2",
      "e2e-2of2",
      "integration",
      "live",
      "ui",
      "cloud",
    ]);
    expect(lanes[0]).toMatchObject({
      script: "test",
      shard: "1/4",
      kind: "run-all-tests",
    });
    expect(lanes.at(-1)).toMatchObject({
      kind: "command",
      command: "bun run test:cloud",
    });
  });

  test("omits the cloud lane when the plan has no cloud step", () => {
    const lanes = deriveLanes(
      { ...fixturePlan, cloudStep: null },
      DEFAULT_PARAMS,
    );
    expect(lanes.some((lane) => lane.name === "cloud")).toBe(false);
  });

  test("a new scriptName in the plan appears as a new lane without code changes", () => {
    const plan = {
      ...fixturePlan,
      summary: {
        byScript: { ...fixturePlan.summary.byScript, "test:visual": 3 },
      },
    };
    const lanes = deriveLanes(plan, DEFAULT_PARAMS);
    expect(
      lanes.some(
        (lane) => lane.name === "visual" && lane.script === "test:visual",
      ),
    ).toBe(true);
  });

  test("rejects a plan without byScript", () => {
    expect(() => deriveLanes({ summary: {} }, DEFAULT_PARAMS)).toThrow(
      /byScript/,
    );
    expect(() => deriveLanes({}, DEFAULT_PARAMS)).toThrow(/byScript/);
  });

  test("rejects non-positive shard params", () => {
    expect(() =>
      deriveLanes(fixturePlan, { ...DEFAULT_PARAMS, unitShards: 0 }),
    ).toThrow(/unitShards/);
    expect(() =>
      deriveLanes(fixturePlan, { ...DEFAULT_PARAMS, e2eShards: 1.5 }),
    ).toThrow(/e2eShards/);
  });
});

describe("allocateCpusets", () => {
  test("partitions cores contiguously with the remainder front-loaded", () => {
    expect(allocateCpusets(16, 10)).toEqual([
      { cpuset: "0-1", cpus: 2 },
      { cpuset: "2-3", cpus: 2 },
      { cpuset: "4-5", cpus: 2 },
      { cpuset: "6-7", cpus: 2 },
      { cpuset: "8-9", cpus: 2 },
      { cpuset: "10-11", cpus: 2 },
      { cpuset: "12", cpus: 1 },
      { cpuset: "13", cpus: 1 },
      { cpuset: "14", cpus: 1 },
      { cpuset: "15", cpus: 1 },
    ]);
  });

  test("covers every core exactly once", () => {
    for (const [cores, lanes] of [
      [16, 10],
      [32, 10],
      [9, 9],
      [64, 3],
    ]) {
      const allocations = allocateCpusets(cores, lanes);
      const covered = allocations.flatMap(({ cpuset }) => {
        const [first, last] = cpuset.split("-").map(Number);
        const end = last ?? first;
        return Array.from({ length: end - first + 1 }, (_, i) => first + i);
      });
      expect(covered).toEqual(Array.from({ length: cores }, (_, i) => i));
      expect(allocations.reduce((sum, a) => sum + a.cpus, 0)).toBe(cores);
    }
  });

  test("refuses more lanes than cores instead of oversubscribing pinned sets", () => {
    expect(() => allocateCpusets(8, 10)).toThrow(/10 lanes/);
  });
});

describe("escapeComposeValue", () => {
  test("doubles $ so anchored regexes survive compose interpolation", () => {
    expect(escapeComposeValue("^test$")).toBe("^test$$");
    expect(escapeComposeValue("^test:e2e$")).toBe("^test:e2e$$");
    expect(escapeComposeValue("no dollars")).toBe("no dollars");
  });
});

describe("resolveParams / paramsAreDefault", () => {
  test("defaults, overrides, and validation", () => {
    expect(resolveParams({})).toEqual(DEFAULT_PARAMS);
    expect(paramsAreDefault(resolveParams({}))).toBe(true);
    const custom = resolveParams({ cores: "32", "unit-shards": "6" });
    expect(custom.cores).toBe(32);
    expect(custom.unitShards).toBe(6);
    expect(paramsAreDefault(custom)).toBe(false);
    expect(() => resolveParams({ cores: "0" })).toThrow(/--cores/);
    expect(() => resolveParams({ "e2e-shards": "abc" })).toThrow(
      /--e2e-shards/,
    );
  });
});

describe("renderCompose", () => {
  test("is deterministic and carries pinning, mounts, and both profiles", () => {
    const render = () =>
      renderCompose(
        buildComposeModel(fixturePlan, DEFAULT_PARAMS, fixtureModelSets),
      );
    const text = render();
    expect(render()).toBe(text);
    expect(text).toContain('TEST_SCRIPT_FILTER: "^test$$"');
    expect(text).toContain('TEST_SHARD: "1/4"');
    expect(text).toContain('cpuset: "0-1"');
    expect(text).toContain("${ELIZA_REPO_ROOT:-../..}:/repo:ro");
    expect(text).toContain("scratch-lane-unit-1of4:/work");
    expect(text).toContain("build-cache:/cache");
    expect(text).toContain("gpu-vision:");
    expect(text).toContain("gpu-queue-worker:");
    expect(text).toContain('OCR_MODEL: "/models/ocr/ocr.gguf"');
    // Referenced image is owned by #14548 — this stack consumes, never builds.
    expect(text).toContain("ghcr.io/elizaos/certification-gpu");
  });

  test("rejects missing model sets", () => {
    expect(() => buildComposeModel(fixturePlan, DEFAULT_PARAMS, {})).toThrow(
      /MODEL_SETS/,
    );
  });
});

describe("committed compose.yml", () => {
  test("drift gate: committed file matches regeneration from the live plan", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(here, "generate-compose-lanes.mjs"), "--check"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("matches regeneration");
  }, 120_000);

  test("validates: real `docker compose config` when available, else YAML parse", () => {
    const text = readFileSync(composePath, "utf8");
    // A wedged Docker Desktop can hang even `docker compose version`; a
    // timed-out probe degrades to the YAML branch instead of failing here.
    const probe = spawnSync("docker", ["compose", "version"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    const dockerUsable = !probe.error && probe.status === 0;
    if (dockerUsable) {
      const result = spawnSync(
        "docker",
        [
          "compose",
          "-f",
          composePath,
          "--project-directory",
          here,
          "--profile",
          "cpu",
          "--profile",
          "gpu",
          "config",
          "--quiet",
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      if (result.status !== 0) {
        throw new Error(`docker compose config failed:\n${result.stderr}`);
      }
      console.log(
        "[compose-lanes.test] validated with real `docker compose config`",
      );
      return;
    }
    // Docker-less fallback (stated, not silent): structural YAML sanity only.
    console.log(
      "[compose-lanes.test] docker unavailable — YAML-parse sanity check instead",
    );
    const doc = Bun.YAML.parse(text);
    expect(doc.name).toBe("eliza-certification");
    expect(Object.keys(doc.services).length).toBeGreaterThanOrEqual(12);
    expect(doc.services["gpu-vision"].profiles).toEqual(["gpu"]);
    expect(doc.volumes["build-cache"]).toBeDefined();
  }, 120_000);

  test("committed lane env survives YAML + compose interpolation round-trip", () => {
    const doc = Bun.YAML.parse(readFileSync(composePath, "utf8"));
    const lane = doc.services["lane-unit-1of4"];
    // In-file value is the $$-escaped form; compose unescapes it at runtime
    // (verified against a live daemon: container env receives `^test$`).
    expect(lane.environment.TEST_SCRIPT_FILTER).toBe("^test$$");
    expect(lane.environment.TEST_SHARD).toBe("1/4");
    expect(lane.cpus).toBe(2);
    expect(lane.restart).toBe("no");
  });
});
