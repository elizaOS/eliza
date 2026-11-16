// The generator on a copy of test/fixtures that nothing else reads or writes, in the system's temporary
// directory. The copy needs no install: fixtures/modules, its `node_modules`, declares what the fixtures import.
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { type Component, generator, watched } from "../emit.ts";

const root = mkdtempSync(join(realpathSync(tmpdir()), "stories-fixtures-"));
cpSync(join(import.meta.dirname, "fixtures"), root, { recursive: true });
renameSync(join(root, "modules"), join(root, "node_modules"));
afterAll(() => rmSync(root, { recursive: true }));

const out = join(root, "generated", "stories");
const run = generator({ root });
const first = run();
const component = (name: string, from = first): Component => from.index.components.find((c) => c.name === name)!;
const stories = (name: string, from = first) => component(name, from).stories.map((s) => `${s.kind} ${s.id}`);
const read = (name: string) => readFileSync(join(out, name), "utf8");
const everything = () => Object.fromEntries(readdirSync(out).sort().map((name) => [name, read(name)]));
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
    // A play of its own runs first.
    'export const Loading = { args: { ...base, loading: true, onClick: fn() }, play: async (context) => { await given.play["Loading"](context); await refuses(context); } };',
  ])
    expect(file).toContain(line);
  expect(read("kit-kinds.stories.tsx")).not.toContain("refuses");
});

it("links a component to its spec model and renders it from the generated initial state", () => {
  expect(component("Receipt")).toMatchObject({ model: { spec: "spec/index.md", module: "index", state: "Order", events: ["addItem", "pay"] }, design: ["design.md#receipt"] });
  expect(component("Receipt").stories[1]).toEqual({ id: "kit-receipt--model", name: "Model", kind: "model", args: { order: { status: "Draft", units: 0 } } });
  expect(read("kit-receipt.stories.tsx")).toContain('import { initial } from "../../gen/index.ts";');
  expect(read("kit-receipt.stories.tsx")).toContain("export const Model = { args: { ...base, order: initial } };");
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
});

it("rewrites only what a change touches, and removes what a deleted component left", () => {
  edit("src/Tag.tsx", (text) => text.replace('lg: "l" }', 'lg: "l", xl: "x" }'));
  expect(run()).toMatchObject({ written: ["kit-tag.stories.tsx", "catalog.json", "manifest.json"], removed: [], analyzed: 1 });
  expect(stories("Tag", run())).toContain("prop kit-tag--size-xl");
  expect(["src/Tag.tsx", "tsconfig.json", "generated/stories/kit-tag.stories.tsx", "node_modules/react/index.ts", ".cache/Tag.tsx"].filter(watched(root))).toEqual(["src/Tag.tsx", "tsconfig.json"]);

  // A type reached through a path alias is an input, and so is the tsconfig that names the alias.
  edit("src/shades.ts", (text) => text.replace('"red"', '"crimson"'));
  expect(stories("Many", run())).toContain("prop kit-many--hue-crimson");
  edit("tsconfig.json", (text) => text.replace('"strict": true', '"strict": false'));
  expect(run()).toMatchObject({ written: ["manifest.json"], analyzed: 7 });

  writeFileSync(join(root, "src/Table.meta.ts"), 'export const meta = { args: { rows: [{ id: 1 }], sort: { by: "id" } } };\n');
  const given = run();
  expect(given).toMatchObject({ written: ["kit-table.stories.tsx", "catalog.json", "stories.test.tsx", "stories.browser.test.tsx", "manifest.json"], analyzed: 1, diagnostics: [] });
  expect(component("Table", given).stories).toEqual([{ id: "kit-table--default", name: "Default", kind: "default", args: { rows: [{ id: 1 }], sort: { by: "id" } } }, { id: "kit-table--empty", name: "Empty", kind: "state", args: { rows: [], sort: { by: "id" } } }]);

  // Args that are not all written out may give a required prop; a bound that is not a pair is reported, not thrown.
  edit("src/Table.meta.ts", (text) => text.replace("rows: [{ id: 1 }],", "...{ rows: [{ id: 1 }] },"));
  // A field ComponentMeta does not have, such as the `snapshot` it once had, is reported, not ignored.
  edit("src/Meter.meta.ts", (text) => text.replace("[0, full]", "full").replace("decorator:", 'snapshot: ["Failed"],\n  decorator:'));
  expect(run().diagnostics).toEqual([
    'Meter: `bounds` of "value" must be written out as two numbers, `[least, greatest]`, in Meter.meta.ts',
    "Meter: `snapshot` is no field of ComponentMeta (vibestack/stories/meta.ts) and is not read; remove it from Meter.meta.ts",
  ]);

  rmSync(join(root, "src/Chip.tsx"));
  const gone = run();
  expect(gone).toMatchObject({ removed: ["kit-chip.stories.tsx"], analyzed: 0 });
  expect(gone.index.components.map((c) => c.name)).not.toContain("Chip");
  expect(read("stories.test.tsx")).not.toContain("Chip.stories.tsx");
  expect(read("stories.browser.test.tsx")).not.toContain("Chip.stories.tsx");
});
