import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  discoverScenarios,
  listScenarioMetadata,
  loadAllScenarios,
  loadScenarioFile,
} from "./loader.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

it("discovers manifests statically without executing setup and applies per-entry lanes and filters", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scenario-manifest-"));
  directories.push(dir);
  const file = path.join(dir, "mixed.scenarios.ts");
  await writeFile(
    file,
    `throw new Error("metadata must not execute module setup");
export default [
  { id: "live", title: "Live", domain: "test", turns: [{ kind: "message", text: "hello" }] },
  { id: "offline", title: "Offline", lane: "pr-deterministic", domain: "test", turns: [{ kind: "message", text: "hello" }] },
];`,
  );
  expect(await discoverScenarios(dir)).toEqual([file]);
  expect(
    (
      await listScenarioMetadata(dir, undefined, undefined, false, "live-only")
    ).map((s) => s.id),
  ).toEqual(["live"]);
  expect(
    (await listScenarioMetadata(dir, new Set(["offline"]), undefined, true))
      .length,
  ).toBe(11);
});

it("loads all manifest entries while preserving singular-loader behavior and rejecting invalid entries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scenario-manifest-"));
  directories.push(dir);
  const file = path.join(dir, "mixed.scenarios.ts");
  await writeFile(
    file,
    `export default [
  { id: "first", title: "First", domain: "test", turns: [{ kind: "message", text: "complete first input" }] },
  { id: "second", title: "Second", lane: "pr-deterministic", domain: "test", turns: [{ kind: "message", text: "complete second input" }] },
];`,
  );
  const loaded = await loadAllScenarios(
    dir,
    undefined,
    undefined,
    false,
    "pr-deterministic",
  );
  expect(loaded.map((s) => s.scenario.id)).toEqual(["second"]);
  expect(loaded[0].scenario.turns[0]).toEqual({
    kind: "message",
    text: "complete second input",
  });
  await expect(loadScenarioFile(file)).rejects.toThrow("contains 2 scenarios");
  await writeFile(
    path.join(dir, "invalid.scenarios.ts"),
    'export default [{ id: "invalid" }];',
  );
  await expect(loadAllScenarios(dir)).rejects.toThrow(
    "matching ScenarioDefinition",
  );
});
