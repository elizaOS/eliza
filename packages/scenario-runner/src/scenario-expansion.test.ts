/** Tests scenario discovery and edge-variant expansion (loader.ts): loading `.scenario.ts` files from a temp dir, static metadata listing, corpus counting/validation, and `expandScenarioDefinition` variant generation. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  countScenarioCorpus,
  expandScenarioDefinition,
  listScenarioMetadata,
  loadAllScenarios,
  loadScenarioFile,
  SCENARIO_EDGE_VARIANTS,
  validateScenarioCorpus,
} from "./loader.ts";

const tempDirs: string[] = [];

async function makeTempScenarioDir(): Promise<string> {
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = await mkdtemp(join(packageDir, ".tmp-scenario-expansion-"));
  tempDirs.push(dir);
  return dir;
}

async function writeScenarioFile(
  dir: string,
  name: string,
  source: string[],
): Promise<void> {
  await writeFile(join(dir, name), `${source.join("\n")}\n`);
}

async function writeTwoBaseScenarioDir(): Promise<{
  dir: string;
  baseIdA: string;
  baseIdB: string;
}> {
  const dir = await makeTempScenarioDir();
  const baseIdA = "fixture.todo.create";
  const baseIdB = "fixture.todo.list";
  await writeScenarioFile(dir, "todo.create.scenario.ts", [
    'import { scenario } from "@elizaos/scenario-runner/schema";',
    "export default scenario({",
    `  id: "${baseIdA}",`,
    '  title: "Create fixture todo",',
    '  domain: "fixture",',
    '  tags: ["fixture"],',
    '  turns: [{ kind: "message", name: "create", text: "Create a todo for the report." }],',
    "});",
  ]);
  await writeScenarioFile(dir, "todo.list.scenario.ts", [
    'import { scenario } from "@elizaos/scenario-runner/schema";',
    "export default scenario({",
    `  id: "${baseIdB}",`,
    '  title: "List fixture todos",',
    '  domain: "fixture",',
    '  tags: ["fixture"],',
    '  turns: [{ kind: "message", name: "list", text: "List my open todos." }],',
    "});",
  ]);
  return { dir, baseIdA, baseIdB };
}

async function writeFixtureScenario(): Promise<string> {
  const dir = await makeTempScenarioDir();
  await writeFile(
    join(dir, "todo.create.scenario.ts"),
    [
      'import { scenario } from "@elizaos/scenario-runner/schema";',
      "export default scenario({",
      '  id: "fixture.todo.create",',
      '  title: "Create fixture todo",',
      '  domain: "fixture",',
      '  tags: ["fixture"],',
      '  turns: [{ kind: "message", name: "create", text: "Create a todo for the report." }],',
      "});",
      "",
    ].join("\n"),
  );
  return dir;
}

describe("scenario-runner edge expansion", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("counts exactly ten edge scenarios per authored scenario", async () => {
    const dir = await writeFixtureScenario();
    const counts = await countScenarioCorpus(dir);

    expect(SCENARIO_EDGE_VARIANTS).toHaveLength(10);
    expect(counts).toEqual({
      suite: "scenario-runner",
      existing: 1,
      added: 10,
      total: 11,
      multiplierAdded: 10,
    });
  });

  it("lists expanded metadata without importing scenario modules", async () => {
    const dir = await writeFixtureScenario();
    const listed = await listScenarioMetadata(dir, undefined, undefined, true);

    expect(listed.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining([
        "fixture.todo.create",
        "fixture.todo.create--edge-prompt-injection",
      ]),
    );
    expect(listed).toHaveLength(11);
  });

  it("loads expanded scenarios with safe edge context in user text", async () => {
    const dir = await writeFixtureScenario();
    const loaded = await loadAllScenarios(
      dir,
      new Set(["fixture.todo.create--edge-permission-denied"]),
      undefined,
      true,
    );

    expect(loaded).toHaveLength(1);
    expect(loaded[0].scenario.title).toContain("Permission Denied");
    expect(loaded[0].scenario.tags).toContain("edge-expanded");
    expect(loaded[0].scenario.turns[0]).toMatchObject({
      text: expect.stringContaining("deny permission"),
    });
  });

  it("validates expanded corpora", async () => {
    const dir = await writeFixtureScenario();
    await expect(validateScenarioCorpus(dir)).resolves.toMatchObject({
      valid: true,
      total: 11,
      uniqueIds: 11,
      expansionMatches: true,
    });
  });

  it("detects authored ids that collide with generated edge ids", async () => {
    const dir = await makeTempScenarioDir();
    await writeScenarioFile(dir, "base.scenario.ts", [
      "export default {",
      '  id: "fixture.todo.create",',
      '  title: "Create fixture todo",',
      '  domain: "fixture",',
      '  turns: [{ kind: "message", name: "create", text: "Create a todo." }],',
      "};",
    ]);
    await writeScenarioFile(dir, "colliding.scenario.ts", [
      "export default {",
      '  id: "fixture.todo.create--edge-permission-denied",',
      '  title: "Authored collision",',
      '  domain: "fixture",',
      '  turns: [{ kind: "message", name: "create", text: "Create a todo." }],',
      "};",
    ]);

    await expect(validateScenarioCorpus(dir)).rejects.toThrow(
      "fixture.todo.create--edge-permission-denied",
    );
  });

  it("only appends edge context to non-blank message-like turn text", () => {
    const expanded = expandScenarioDefinition("fixture.scenario.ts", {
      id: "fixture.mixed",
      title: "Mixed turns",
      domain: "fixture",
      turns: [
        { kind: "message", name: "blank", text: "   " },
        { kind: "action", name: "act", actionName: "TEST_ACTION" },
        { kind: "message", name: "filled", text: "Do the thing." },
      ],
    });

    expect(expanded[0].scenario.turns[0]).toMatchObject({ text: "   " });
    expect(expanded[0].scenario.turns[1]).toMatchObject({
      kind: "action",
      actionName: "TEST_ACTION",
    });
    expect(expanded[0].scenario.turns[2]).toMatchObject({
      text: expect.stringContaining("Extra edge context:"),
    });
  });

  it("validates a corpus filtered to a single base id (regression #24807)", async () => {
    // Before the fix `--validate-scenarios --scenario <baseId>` threw
    // "invalid expanded corpus" because the id filter matched only the base
    // while countScenarioCorpus projected a blind base×(1+variants) total.
    const { dir, baseIdA } = await writeTwoBaseScenarioDir();
    const filter = new Set([baseIdA]);

    const result = await validateScenarioCorpus(dir, filter);
    expect(result).toMatchObject({
      valid: true,
      total: 11,
      uniqueIds: 11,
      expansionMatches: true,
      duplicateIds: [],
      missingIds: [],
    });

    const expandedListing = await listScenarioMetadata(
      dir,
      filter,
      undefined,
      true,
    );
    expect(result.total).toBe(expandedListing.length);
  });

  it("counts a base-id-filtered corpus consistently with the expanded listing (regression #24807)", async () => {
    const { dir, baseIdA } = await writeTwoBaseScenarioDir();
    const filter = new Set([baseIdA]);

    const counts = await countScenarioCorpus(dir, filter);
    const expandedListing = await listScenarioMetadata(
      dir,
      filter,
      undefined,
      true,
    );

    // total must equal the number of scenarios a filtered expanded run selects,
    // not a blind 11× of every base in the directory.
    expect(counts.total).toBe(expandedListing.length);
    expect(counts).toMatchObject({
      suite: "scenario-runner",
      existing: 1,
      added: 10,
      total: 11,
      multiplierAdded: 10,
    });
    // The unrelated base in the same directory must not leak into the count.
    expect(
      expandedListing.every(
        (scenario) =>
          scenario.id === baseIdA || scenario.baseScenarioId === baseIdA,
      ),
    ).toBe(true);
  });

  it("loads a base and its edge variants when filtered by base id (regression #24807)", async () => {
    // Previously the post-expansion id filter dropped every variant because
    // their generated ids (`<id>--edge-*`) are absent from the base-id filter.
    const { dir, baseIdA, baseIdB } = await writeTwoBaseScenarioDir();
    const loaded = await loadAllScenarios(
      dir,
      new Set([baseIdA]),
      undefined,
      true,
    );

    const ids = loaded.map((entry) => entry.scenario.id);
    expect(ids).toHaveLength(1 + SCENARIO_EDGE_VARIANTS.length);
    expect(ids).toContain(baseIdA);
    for (const variant of SCENARIO_EDGE_VARIANTS) {
      expect(ids).toContain(`${baseIdA}--edge-${variant.suffix}`);
    }
    // The sibling base and its variants must be excluded by the filter.
    expect(ids.some((id) => id.startsWith(baseIdB))).toBe(false);
  });

  it("still selects exactly one scenario when filtered by a generated edge id", async () => {
    const { dir, baseIdA } = await writeTwoBaseScenarioDir();
    const edgeId = `${baseIdA}--edge-prompt-injection`;
    const loaded = await loadAllScenarios(
      dir,
      new Set([edgeId]),
      undefined,
      true,
    );

    expect(loaded).toHaveLength(1);
    expect(loaded[0].scenario.id).toBe(edgeId);
    expect(loaded[0].scenario.baseScenarioId).toBe(baseIdA);
  });

  it("lists static metadata without importing modules with runtime-only top-level code", async () => {
    const dir = await makeTempScenarioDir();
    await writeScenarioFile(dir, "static-only.scenario.ts", [
      'if (process.env.SHOULD_NOT_IMPORT_SCENARIO === "1") {',
      '  throw new Error("scenario module was imported");',
      "}",
      "export default {",
      '  id: "fixture.static.only",',
      '  title: "Static only",',
      '  domain: "fixture",',
      '  tier: "T2",',
      '  turns: [{ kind: "message", name: "ask", text: "Hello" }],',
      "};",
    ]);

    process.env.SHOULD_NOT_IMPORT_SCENARIO = "1";
    try {
      await expect(listScenarioMetadata(dir)).resolves.toMatchObject([
        { id: "fixture.static.only", title: "Static only", tier: "T2" },
      ]);
      await expect(
        loadScenarioFile(join(dir, "static-only.scenario.ts")),
      ).rejects.toThrow("scenario module was imported");
    } finally {
      delete process.env.SHOULD_NOT_IMPORT_SCENARIO;
    }
  });
});
