// Chooses a component's stories: a representative few, one thing varied at a time, never the cross
// product. A value is derived only where the prop's type gives one; otherwise the metadata file must.
import { basename } from "node:path";
import { type Found, STATE } from "./analyze.ts";

export interface Story {
  id: string;
  name: string;
  kind: "default" | "prop" | "state" | "example" | "model";
  args: Record<string, unknown>;
}
/** A story as the generated file writes it: `args` is source text. */
/** `refuses`: the story renders the component disabled or loading, so its generated `play` checks nothing it was handed fires. */
interface Planned { export: string; args: string; play?: string; refuses: boolean }
export interface Plan { id: string; title: string; base: string; samples: number; stories: Planned[]; catalog: Story[]; diagnostics: string[] }

/** Source text standing for a value, such as `fn()`; the catalog leaves it out. */
class Code {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
  toJSON(): undefined {
    return undefined;
  }
}
const fields = (values: Record<string, unknown>) =>
  Object.entries(values).map(([name, value]) => `${/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)}: ${value instanceof Code ? value.text : value === undefined ? "undefined" : JSON.stringify(value)}`);

// Storybook's own rules (storybook/src/csf: `sanitize`, `toStartCaseStr`, `toId`), so that an id here is the id it serves.
const sanitize = (text: string) => text.toLowerCase().replace(/[ ’–—―′¿'`~!@#$%^&*()_|+\-=?;:'",.<>{}[\]\\/]/gi, "-").replace(/-+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
const startCase = (text: string) =>
  text.replace(/[_\-.]/g, " ").replace(/([^\n])([A-Z])([a-z])/g, "$1 $2$3").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([a-z])([0-9])/gi, "$1 $2").replace(/([0-9])([a-z])/gi, "$1 $2")
    .replace(/(\s|^)(\w)/g, (_, space: string, letter: string) => space + letter.toUpperCase()).replace(/ +/g, " ").trim();
const storyId = (component: string, exportName: string) => `${component}--${sanitize(startCase(exportName))}`;

/** A story's export name: the words of a label run together, each capitalized. */
const pascal = (label: string) => {
  const name = label.split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join("");
  return /^[A-Z]/.test(name) ? name : `Story${name}`;
};

/** A bound as `[least, greatest]`, when the metadata wrote it as two numbers. */
const pair = (bound: unknown) => (Array.isArray(bound) && bound.length === 2 && bound.every((n) => typeof n === "number") ? (bound as [number, number]) : undefined);

/** How many values a schema is sampled for: the first fills the default story, each other is a story. */
const SAMPLES = 3;

export function plan(c: Found, cap: number): Plan {
  const bare = c.package.replace(/^@[^/]+\//, "");
  const id = `${sanitize(bare)}-${c.name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
  const title = c.manual?.title ?? `${startCase(bare)}/${c.name}`;
  const meta = c.meta;
  const args = meta?.args ?? {};
  const covered = new Set(meta?.schema);
  const diagnostics: string[] = [];

  // What the type alone gives: a spy for a function, a label for text, the first option. Data is never invented.
  const base: Record<string, unknown> = {};
  for (const p of c.props) {
    if (p.name in args || covered.has(p.name)) continue;
    if (p.kind === "function") base[p.name] = new Code("fn()");
    else if (p.name === "children" && p.kind === "node") base.children = c.name;
    else if (!p.required) continue;
    else if (p.name === c.model?.prop) base[p.name] = new Code("initial");
    else if (p.kind === "string" || p.kind === "node") base[p.name] = startCase(p.name);
    else if (p.kind === "number") base[p.name] = pair(meta?.bounds[p.name])?.[0] ?? 0;
    else if (p.kind === "boolean") base[p.name] = false;
    else if (p.kind === "union") base[p.name] = p.options![0];
    // Args that could not all be read may give it when the story runs.
    else if (!meta?.open) diagnostics.push(`${c.name}: required prop "${p.name}" (${p.kind}) has no value to render with; give one in \`args\` of ${c.name}.meta.tsx`);
  }
  const plain = { ...base, ...args };
  const result = { id, title, samples: meta?.schema ? SAMPLES : 0, base: `{ ${[...fields(base), ...(meta?.schema ? ["...samples[0]"] : []), ...(meta ? ["...given.args"] : [])].join(", ")} }` };
  // A part is shown by the stories of the component it belongs to, unless it describes itself.
  if (c.part && !meta && !c.manual) return { ...result, stories: [], catalog: [], diagnostics: [] };
  if (diagnostics.length) return { ...result, stories: [], catalog: [], diagnostics };

  const all: { name: string; kind: Story["kind"]; code: string; shown: Record<string, unknown>; refuses: boolean }[] = [];
  const add = (label: string, kind: Story["kind"], set: Record<string, unknown>, from = ["base"], shown: Record<string, unknown> = { ...plain, ...set }) => {
    // A disabled or loading story gets a spy for the click every element can take, unless the type gave one already.
    const refuses = shown.disabled === true || shown.loading === true;
    const spied = refuses && !(base.onClick instanceof Code) ? { ...set, onClick: new Code("fn()") } : set;
    const code = `{ ${[...from.map((f) => `...${f}`), ...fields(spied)].join(", ")} }`;
    if (!all.some((s) => s.name === pascal(label))) all.push({ name: pascal(label), kind, code, shown, refuses });
  };
  const prop = (...names: string[]) => c.props.find((p) => names.includes(p.name));

  add("Default", "default", {});
  for (const [name, values] of Object.entries(meta?.examples ?? {})) add(name, "example", {}, ["base", `given.examples[${JSON.stringify(name)}]`], { ...plain, ...values });
  for (const [name, values] of Object.entries(meta?.states ?? {})) add(name, "state", {}, [`given.states[${JSON.stringify(name)}]`], values);
  for (const [name, bound] of Object.entries(meta?.bounds ?? {})) {
    const [least, greatest] = pair(bound) ?? [];
    if (least === undefined) diagnostics.push(`${c.name}: \`bounds\` of "${name}" must be written out as two numbers, \`[least, greatest]\`, in ${basename(meta!.file)}`);
    else {
      add(`${name} min`, "prop", { [name]: least });
      add(`${name} max`, "prop", { [name]: greatest });
    }
  }
  if (c.model?.prop) add("Model", "model", { [c.model.prop]: new Code("initial") }, ["base"], { ...plain, [c.model.prop]: c.model.initial });
  for (let i = 1; i < result.samples; i++) add(`Sample ${i}`, "example", {}, ["base", `samples[${i}]`], plain);

  // A state story only where the component has the prop for it.
  for (const [name, state] of [["Disabled", prop("disabled")], ["Loading", prop("loading")], ["Error", prop("error", "invalid")]] as const) {
    if (state?.kind === "boolean") add(name, "state", { [state.name]: true });
    else if (state?.kind === "string" || state?.kind === "node") add(name, "state", { [state.name]: "Something went wrong" });
  }
  const list = c.props.find((p) => p.kind === "array");
  if (list) add("Empty", "state", { [list.name]: [] });
  else if ("children" in plain) add("Empty", "state", { children: undefined });

  // One prop at a time, and one option of each prop before a second of any, so the cap cuts evenly; the
  // component's own props before those it inherits, so the cap cuts those first.
  for (const own of [true, false]) {
    const varied = c.props.filter((p) => !STATE.test(p.name) && c.inherited.includes(p.name) !== own).map((p) => {
      const usual = p.name in plain ? plain[p.name] : p.default;
      if (p.kind === "union") return p.options!.filter((option) => option !== usual).map((option) => [`${p.name} ${option}`, { [p.name]: option }] as const);
      return p.kind === "boolean" ? [[p.name, { [p.name]: usual !== true }] as const] : [];
    });
    for (let i = 0; varied.some((options) => i < options.length); i++) for (const options of varied) if (options[i]) add(options[i][0], "prop", options[i][1]);
  }

  for (const key of meta?.extra ?? []) diagnostics.push(`${c.name}: \`${key}\` is no field of ComponentMeta (vibestack/stories/meta.ts) and is not read; remove it from ${basename(meta!.file)}`);
  for (const key of meta?.play ?? []) if (!all.some((s) => s.name === pascal(key))) diagnostics.push(`${c.name}: \`play\` names "${key}", which is no story of it`);
  const manual = c.manual;
  const kept = all.filter((s) => !manual?.exports.includes(s.name)).slice(0, cap);
  const theirs = manual?.id ?? manual?.title;
  if (manual && !theirs) diagnostics.push(`${c.name}: ${basename(manual.file)} needs \`title: "${title}"\` in its default export to sit with the generated stories`);
  return {
    ...result,
    diagnostics,
    stories: kept.map((s) => ({ export: s.name, args: s.code, play: meta?.play.find((key) => pascal(key) === s.name), refuses: s.refuses })),
    catalog: [
      ...kept.map((s) => ({ id: storyId(id, s.name), name: startCase(s.name), kind: s.kind, args: s.shown })),
      ...(manual && theirs ? manual.exports.map((name) => ({ id: storyId(sanitize(theirs), name), name: startCase(name), kind: "example" as const, args: {} })) : []),
    ],
  };
}
