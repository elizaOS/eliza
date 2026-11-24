// The generator on a copy of test/fixtures that nothing else reads or writes, in the system's temporary
// directory. The copy needs no install: fixtures/modules, its `node_modules`, declares what the fixtures import.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, expect, it } from "vitest";
import { type Component, generator, listener, watched } from "../emit.ts";

const root = mkdtempSync(join(realpathSync(tmpdir()), "stories-fixtures-"));
cpSync(join(import.meta.dirname, "fixtures"), root, { recursive: true });
renameSync(join(root, "modules"), join(root, "node_modules"));
afterAll(() => rmSync(root, { recursive: true }));

const out = join(root, "generated", "stories");
const run = generator({ root });
const first = run();
const writeFiles = (dir: string, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
};
const component = (name: string, from = first): Component => from.index.components.find((c) => c.name === name)!;
const stories = (name: string, from = first) => component(name, from).stories.map((s) => `${s.kind} ${s.id}`);
const read = (name: string) => readFileSync(join(out, name), "utf8");
const everything = () => Object.fromEntries(readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(out, join(e.parentPath, e.name))).sort().map((name) => [name, read(name)]));
const edit = (file: string, change: (text: string) => string) => writeFileSync(join(root, file), change(readFileSync(join(root, file), "utf8")));

it("finds the exported components and nothing else", () => {
  expect(first.index.components.map((c) => c.id)).toEqual(["kit-chip", "kit-kinds", "kit-many", "kit-meter", "kit-receipt", "kit-table", "kit-tag"]);
  expect(component("Kinds")).toMatchObject({ package: "@fixture/kit", title: "Kit/Kinds", description: "One prop of every kind.", source: { file: "src/Kinds.tsx", line: 17 } });
});

it("reads each kind of prop, with the defaults its destructuring gives", () => {
  expect(component("Kinds").props).toEqual([
    { name: "label", kind: "string", required: true, description: "What it is called." },
    { name: "flag", kind: "boolean", required: false },
    { name: "count", kind: "number", required: false, default: 2 },
    { name: "tone", kind: "union", options: ["info", "warn", "bad"], required: false, default: "info" },
    { name: "onPick", kind: "function", required: false },
    { name: "icon", kind: "node", required: false },
    { name: "box", kind: "object", required: false },
    { name: "items", kind: "array", required: false, default: [] },
    { name: "anything", kind: "unknown", required: false },
  ]);
});

it("varies one prop at a time from a derived default, with a spy for a function", () => {
  expect(stories("Kinds")).toEqual(["default kit-kinds--default", "state kit-kinds--empty", "prop kit-kinds--flag", "prop kit-kinds--tone-warn", "prop kit-kinds--tone-bad"]);
  expect(component("Kinds").stories[3]).toEqual({ id: "kit-kinds--tone-warn", name: "Tone Warn", kind: "prop", args: { label: "Label", tone: "warn" } });
  // Under an alias, so that a component named Empty or Default cannot meet a story of that name.
  expect(read("kit-kinds.stories.tsx")).toContain('import { Kinds as component } from "../../src/Kinds.tsx";\n\nconst base = { label: "Label", onPick: fn() };\n\nexport default { id: "kit-kinds", title: "Kit/Kinds", component };');
});

it("reads CVA variants in the order written, and their defaults, and varies them before an inherited prop", () => {
  expect(component("Tag").props.filter((p) => p.kind === "union")).toEqual([
    { name: "translate", kind: "union", options: ["no", "yes"], required: false },
    { name: "size", kind: "union", options: ["sm", "md", "lg"], required: false, default: "md" },
    { name: "tone", kind: "union", options: ["quiet", "loud"], required: false, default: "quiet" },
  ]);
  // `children` is only passed on with the rest, and is still what the stories show.
  expect(stories("Tag")).toEqual(["default kit-tag--default", "state kit-tag--empty", "prop kit-tag--size-sm", "prop kit-tag--tone-loud", "prop kit-tag--size-lg", "prop kit-tag--translate-no", "prop kit-tag--translate-yes"]);
});

it("caps the stories of a component, taking an option of each prop before a second of any", () => {
  expect(component("Many").stories).toHaveLength(12);
  // The required `shade` renders as its first option, which is then no story of its own.
  expect(stories("Many").slice(0, 5)).toEqual(["default kit-many--default", "prop kit-many--shade-100", "prop kit-many--hue-red", "prop kit-many--dense", "prop kit-many--shade-200"]);
  const few = generator({ root, out: join(root, "generated", "few"), cap: 3 })();
  expect(stories("Many", few)).toEqual(["default kit-many--default", "prop kit-many--shade-100", "prop kit-many--hue-red"]);
  expect(few.diagnostics).toContain('Meter: `play` names "Loading", which is past the cap of 3 stories');
});

it("reports a required prop it cannot give a value, and writes that component no stories", () => {
  expect(component("Table")).toMatchObject({
    stories: [],
    diagnostics: [
      'Table: required prop "rows" (array) has no value to render with; give one in `args` of Table.meta.tsx',
      'Table: required prop "sort" (object) has no value to render with; give one in `args` of Table.meta.tsx',
    ],
  });
  expect(first.diagnostics).toEqual(component("Table").diagnostics);
  expect(readdirSync(out)).not.toContain("kit-table.stories.tsx");
});

it("uses a metadata file's args, examples, states, bounds, schema, decorator and play", () => {
  expect(stories("Meter")).toEqual([
    "default kit-meter--default",
    "example kit-meter--half-full",
    "state kit-meter--failed",
    "prop kit-meter--value-min",
    "prop kit-meter--value-max",
    "example kit-meter--sample-1",
    "example kit-meter--sample-2",
    "state kit-meter--loading",
    "state kit-meter--error",
    "prop kit-meter--unit-kb",
  ]);
  expect(component("Meter").stories.slice(1, 5).map((s) => s.args)).toEqual([{ unit: "mb", value: 50 }, { value: 0, unit: "kb", error: "No disk" }, { unit: "mb", value: 0 }, { unit: "mb", value: 100 }]);
  const file = read("kit-meter.stories.tsx");
  for (const line of [
    'import { meta as given } from "../../src/Meter.meta.ts";',
    "const samples = Effect.runSync(Arbitrary.sampleEffect(Arbitrary.schema(given.schema), { count: 3, seed: 1 }));",
    "const base = { ...samples[0], ...given.args };",
    "decorators: [(Story) => given.decorator(() => <Story />)]",
    'export const HalfFull = { args: { ...base, ...given.examples["Half full"] }, play: given.play["Half full"] };',
    'export const Failed = { args: { ...given.states["Failed"] } };',
    "export const Sample2 = { args: { ...base, ...samples[2] } };",
  ])
    expect(file).toContain(line);
});

it("plays a disabled or loading story to check that a click, Enter or Space calls none of its spies", () => {
  const file = read("kit-meter.stories.tsx");
  for (const line of [
    'import { expect, fn, isMockFunction, userEvent } from "storybook/test";',
    "const refuses = async ({ args, canvasElement }) => {",
    // A spy another story of the file called is not this story's doing.
    "  for (const value of Object.values(args)) if (isMockFunction(value)) value.mockClear();",
    // A play of its own runs first.
    'export const Loading = { args: { ...base, loading: true, onClick: fn() }, play: async (context) => { await given.play["Loading"](context); await refuses(context); } };',
  ])
    expect(file).toContain(line);
  expect(read("kit-kinds.stories.tsx")).not.toContain("refuses");
});

it("links a component to its spec model and renders it from the generated initial state", async () => {
  expect(component("Receipt")).toMatchObject({ model: { spec: "spec/index.md", module: "index", state: "Order", events: ["addItem", "pay"] }, design: ["design.md#receipt"] });
  expect(component("Receipt").stories[1]).toEqual({ id: "kit-receipt--model", name: "Model", kind: "model", args: { order: { status: "Draft", units: 0 } } });
  expect(read("kit-receipt.stories.tsx")).toContain('import { initial } from "../../gen/index.ts";');
  expect(read("kit-receipt.stories.tsx")).toContain("export const Model = { args: { ...base, order: initial } };");

  const workspace = join(root, "mapped-owner");
  const ui = join(workspace, "packages/ui");
  const model = readFileSync(join(root, "gen/index.ts"), "utf8");
  const declarations = /^export (?:type Status|interface Order) .*$/gm;
  const from = (name: string, units: number) => `import type { Order } from "${name}";\n` + model
    .replace(declarations, "").replace("units: 0", `units: ${units}`);
  const receipt = readFileSync(join(root, "src/Receipt.tsx"), "utf8");
  writeFiles(workspace, {
    "package.json": "{}",
    "domain.ts": model.match(declarations)!.join("\n"),
    "packages/ui/package.json": readFileSync(join(root, "package.json"), "utf8"),
    "packages/ui/tsconfig.json": JSON.stringify({ compilerOptions: { jsx: "react-jsx", noLib: true, types: [] } }),
    "packages/ui/src/Receipt.tsx": receipt.replace("../gen/index.ts", "../../../domain.ts").replace("spec/index.md", "spec/workflow/index.md"),
    "spec/workflow/index.md": "# Workflows",
    "gen/workflow.ts": from("../domain.ts", 0),
    "packages/plugin-workflows/package.json": '{"name":"@fixture/plugin-workflows"}',
    "packages/plugin-workflows/gen/workflow.ts": from("../../../domain.ts", 7),
  });
  const generate = generator({ root: ui });
  const compare = (units: number, modelPath: string) => {
    const warm = generate();
    const control = join(ui, "generated", "clean");
    rmSync(control, { recursive: true, force: true });
    expect(generator({ root: ui, out: control })().index).toEqual(warm.index);
    expect(component("Receipt", warm).stories[1].args).toEqual({ order: { status: "Draft", units } });
    const story = "kit-receipt.stories.tsx";
    const content = readFileSync(join(ui, "generated/stories", story), "utf8");
    expect(content).toBe(readFileSync(join(control, story), "utf8"));
    expect(content).toContain(`import { initial } from "${modelPath}";`);
    return warm;
  };
  compare(0, "../../../../gen/workflow.ts");
  expect(generate().analyzed).toBe(0);
  const owner = "packages/workflow";
  writeFiles(workspace, { [`${owner}/package.json`]: '{}', [`${owner}/gen/workflow.ts`]: from("../../../domain.ts", 9) });
  compare(9, "../../../workflow/gen/workflow.ts");
  writeFiles(ui, { "gen/workflow.ts": from("../../../domain.ts", 9) });
  compare(9, "../../gen/workflow.ts");
  writeFiles(workspace, { "gen/workflow.ts": from("../domain.ts", 3) });
  expect(compare(9, "../../gen/workflow.ts").analyzed).toBe(0);
  rmSync(join(ui, "gen/workflow.ts"));
  compare(9, "../../../workflow/gen/workflow.ts");
  mkdirSync(join(workspace, owner, "spec"));
  compare(3, "../../../../gen/workflow.ts");
  rmSync(join(workspace, owner, "spec"), { recursive: true });
  compare(9, "../../../workflow/gen/workflow.ts");
  rmSync(join(workspace, owner, "package.json"));
  compare(3, "../../../../gen/workflow.ts");
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ specOwners: { workflow: "packages/plugin-workflows" } }));
  compare(7, "../../../plugin-workflows/gen/workflow.ts");
  rmSync(join(workspace, "packages/plugin-workflows/gen/workflow.ts"));
  rmSync(join(workspace, "gen/workflow.ts"));
  expect(component("Receipt", generate()).model).toBeUndefined();
  writeFiles(ui, { "gen/workflow.ts": "" });
  const empty = generate();
  expect(empty.analyzed).toBe(1);
  expect(empty.diagnostics.length).toBeGreaterThan(0);
  expect(generator({ root: ui, out: join(ui, "generated/empty") })().diagnostics).toEqual(empty.diagnostics);
  writeFiles(ui, { "gen/workflow.ts": from("../../../domain.ts", 4) });
  compare(4, "../../gen/workflow.ts");
  rmSync(join(ui, "gen/workflow.ts"));
  writeFiles(workspace, { "gen/workflow.ts": from("../domain.ts", 5) });
  let last = generate();
  const watchedStories = listener(ui, undefined, (observe) => { last = generate(observe); });
  const shows = (units: number) => expect.poll(() => component("Receipt", last).stories[1]?.args, { timeout: 10000 }).toEqual({ order: { status: "Draft", units } });
  try {
    await shows(5);
    writeFiles(workspace, { "gen/replacement.ts": from("../domain.ts", 6) });
    renameSync(join(workspace, "gen/replacement.ts"), join(workspace, "gen/workflow.ts"));
    await shows(6);
    writeFiles(workspace, { "packages/plugin-workflows/gen/workflow.ts": from("../../../domain.ts", 7) });
    await shows(7);
    rmSync(join(workspace, "packages/plugin-workflows/gen"), { recursive: true });
    await shows(6);
    writeFiles(workspace, { "packages/plugin-workflows/gen/workflow.ts": from("../../../domain.ts", 8) });
    await shows(8);
  } finally {
    watchedStories.close();
  }

});

it("leaves a story to the hand-written file that has one of its name", () => {
  expect(stories("Chip")).toEqual(["prop kit-chip--on", "example kit-chip--default", "example kit-chip--custom"]);
  expect(read("kit-chip.stories.tsx")).not.toContain("export const Default");
});

it("writes the catalog Studio reads, and tests that run every generated and manual story in a simulated DOM and in a browser", () => {
  const catalog = JSON.parse(read("catalog.json"));
  expect(catalog).toEqual(JSON.parse(JSON.stringify(first.index)));
  expect(Object.keys(catalog)).toEqual(["version", "components"]);
  expect(Object.keys(catalog.components[4])).toEqual(["id", "name", "package", "title", "description", "source", "props", "stories", "model", "design", "diagnostics"]);
  const files = ["../../src/Chip.stories.tsx", ...["chip", "kinds", "many", "meter", "receipt", "tag"].map((name) => `./kit-${name}.stories.tsx`)]
    .map((file, i) => `import * as s${i} from "${file}";`);
  expect(read("stories.test.tsx").match(/import \* as .*/g)).toEqual(files);
  expect(read("stories.browser.test.tsx").match(/import \* as .*/g)).toEqual(['import * as a11y from "@storybook/addon-a11y/preview";', ...files]);
});

it("writes the same bytes again, and nothing when nothing changed", () => {
  const before = everything();
  expect(run()).toMatchObject({ written: [], removed: [], analyzed: 0 });
  rmSync(out, { recursive: true });
  expect(generator({ root })().written).toHaveLength(10);
  expect(everything()).toEqual(before);
  const mapped = join(root, "mapped-properties");
  const componentFile = "src/ZMapped.tsx";
  const source = [
    "interface Flags { middle?: boolean; last?: boolean; first?: boolean }",
    'type Selected = { [Key in "first" | "middle" | "last"]?: Flags[Key] };',
    "/** First set of flags. */",
    "export function ZMapped({ first, middle, last }: Selected) { return <button/> }",
  ].join("\n");
  writeFiles(mapped, {
    "package.json": '{"name":"@fixture/kit"}',
    "tsconfig.json": readFileSync(join(root, "tsconfig.json"), "utf8"),
    "src/AReverse.tsx": 'export function AReverse({ pick }: { pick?: "last" | "middle" | "first" }) { return <button/> }',
    [componentFile]: source,
  });
  const file = join(mapped, componentFile), time = new Date("2020-10-10T10:10:10Z");
  utimesSync(file, time, time);
  const generate = generator({ root: mapped }), original = generate();
  writeFileSync(file, source.replace("First set", "Other set"));
  utimesSync(file, time, time);
  const edited = generate(), clean = generator({ root: mapped, out: join(mapped, "control") })();
  expect(edited.index).toEqual(clean.index);
  expect(component("ZMapped", edited)).toMatchObject({ description: "Other set of flags.", props: component("ZMapped", original).props });
  expect(generate()).toMatchObject({ written: [], analyzed: 0 });
});

it("rewrites only what a change touches, and removes what a deleted component left", () => {
  edit("src/Tag.tsx", (text) => text.replace('lg: "l" }', 'lg: "l", xl: "x" }'));
  expect(run()).toMatchObject({ written: ["kit-tag.stories.tsx", "catalog.json", ".cache/manifest.json"], removed: [], analyzed: 1 });
  expect(stories("Tag", run())).toContain("prop kit-tag--size-xl");
  expect(["src/Tag.tsx", "tsconfig.json", "package.json", "generated/stories/kit-tag.stories.tsx", "node_modules/react/index.ts", ".cache/Tag.tsx"].filter(watched(root))).toEqual(["src/Tag.tsx", "tsconfig.json", "package.json"]);

  // A type reached through a path alias is an input, and so is the tsconfig that names the alias.
  edit("src/shades.ts", (text) => text.replace('"red"', '"crimson"'));
  expect(stories("Many", run())).toContain("prop kit-many--hue-crimson");
  edit("tsconfig.json", (text) => text.replace('"strict": true', '"strict": false'));
  expect(run()).toMatchObject({ written: [".cache/manifest.json"], analyzed: 7 });

  writeFileSync(join(root, "src/Table.meta.ts"), 'export const meta = { args: { rows: [{ id: 1 }], sort: { by: "id" } } };\n');
  const given = run();
  expect(given).toMatchObject({ written: ["kit-table.stories.tsx", "catalog.json", "stories.test.tsx", "stories.browser.test.tsx", ".cache/manifest.json"], analyzed: 1, diagnostics: [] });
  expect(component("Table", given).stories).toEqual([{ id: "kit-table--default", name: "Default", kind: "default", args: { rows: [{ id: 1 }], sort: { by: "id" } } }, { id: "kit-table--empty", name: "Empty", kind: "state", args: { rows: [], sort: { by: "id" } } }]);

  // Args that are not all written out may give a required prop; a bound that is not a pair is reported, not thrown.
  edit("src/Table.meta.ts", (text) => text.replace("rows: [{ id: 1 }],", "...{ rows: [{ id: 1 }] },"));
  // A field ComponentMeta does not have, such as the `snapshot` it once had, is reported, not ignored.
  edit("src/Meter.meta.ts", (text) => text.replace("[0, full]", "full").replace("decorator:", 'snapshot: ["Failed"],\n  decorator:'));
  // A `@model` naming a spec with no state machine, such as a stateless dispatcher, is reported, not dropped.
  writeFileSync(join(root, "gen/views.ts"), 'export type Event = { type: "open" };\n');
  edit("src/Tag.tsx", (text) => text.replace("export function Tag", "/** @model spec/views.md */\nexport function Tag"));
  expect(run().diagnostics).toEqual([
    'Meter: `bounds` of "value" must be written out as two numbers, `[least, greatest]`, in Meter.meta.ts',
    "Meter: `snapshot` is no field of ComponentMeta (vibestack/stories/meta.ts) and is not read; remove it from Meter.meta.ts",
    "Tag: @model spec/views.md has no state to show: views.ts exports no `initial`; name the spec whose model holds what it shows",
  ]);

  rmSync(join(root, "src/Chip.tsx"));
  const gone = run();
  expect(gone).toMatchObject({ removed: ["kit-chip.stories.tsx"], analyzed: 0 });
  expect(gone.index.components.map((c) => c.name)).not.toContain("Chip");
  expect(read("stories.test.tsx")).not.toContain("Chip.stories.tsx");
  expect(read("stories.browser.test.tsx")).not.toContain("Chip.stories.tsx");
});
