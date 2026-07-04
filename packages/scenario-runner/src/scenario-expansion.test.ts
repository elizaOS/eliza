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
