// Writes what the analysis found: a CSF file per component, the catalog Studio reads (`ComponentIndex`), and two
// Vitest files that run every story: one for a simulated DOM and one for a real browser.
// A component whose inputs hash as they did last time is not analyzed or written again.
import { createHash } from "node:crypto";
import { type FSWatcher, type Stats, existsSync, readFileSync, readdirSync, rmSync, statSync, unwatchFile, watch, watchFile } from "node:fs";
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { writeWhole } from "../run.ts";
import { type Found, type Lookup, type Prop, analyze, beside, compare, isComponentSource, modelFile, modelTag, packageOf, programs, sources } from "./analyze.ts";
import { type Plan, type Story, plan } from "./variants.ts";

export type { Prop, Story };

/** Part of every hash: raise it when the same inputs would be written differently. */
const VERSION = 13;

export interface Component {
  id: string;
  name: string;
  package: string;
  title: string;
  description: string;
  source: { file: string; line: number };
  props: Prop[];
  stories: Story[];
  model?: { spec: string; module: string; state: string; events: string[] };
  design?: string[];
  part?: string;
  children?: string[];
  citations?: { spec: string; heading: string }[];
  uses?: string[];
  diagnostics: string[];
}
/** `catalog.json`. */
export interface ComponentIndex { version: 1; components: Component[] }
export interface Options {
  /** The project: globs and paths in the catalog are relative to it. */
  root: string;
  /** Where the generated files go; `generated/stories` in the project. */
  out?: string;
  /** The most stories generated for one component. */
  cap?: number;
}
interface Result { index: ComponentIndex; written: string[]; removed: string[]; analyzed: number; diagnostics: string[] }
interface Entry { hash: string; inputs: string[]; lookups: Lookup[]; outputs: string[]; manual: string[]; components: Component[] }

const COMPONENTS = ["src/**/*.tsx", "packages/*/src/**/*.tsx"];
// Not a dot-directory: Storybook's index does not follow changes inside one (verified on 10.6.7).
export const outOf = (root: string) => join(root, "generated", "stories");
/** What each source gave, kept in a hidden directory, which no stage's key reads: it changes when only its inputs' hashes do. */
const MANIFEST = ".cache/manifest.json";
const inside = (dir: string, file: string) => {
  const rel = relative(dir, file);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
/** An undiscovered component or workspace directory that can add sources to the catalog. */
export const watched = (root: string, out = outOf(root)) => (file: string) => {
  const absolute = resolve(root, file);
  const name = relative(root, absolute).split(sep).join("/");
  if (!inside(root, absolute) || inside(resolve(root, out), absolute) || /(^|\/)(node_modules|\.[^/]+)\//.test(name)) return false;
  if (name === "tsconfig.json" || basename(absolute) === "package.json") return true;
  if (isComponentSource(name) && COMPONENTS.some((glob) => matchesGlob(name, glob))) return true;
  return /^(?:src(?:\/|$)|packages(?:$|\/[^/]+(?:$|\/src(?:\/|$))))/.test(name)
    && statSync(absolute, { throwIfNoEntry: false })?.isDirectory() === true;
};
export function listener(root: string, out: string | undefined, run: (observe: (file: string) => void) => void) {
  const output = resolve(root, out ?? outOf(root));
  const changes = watched(root, output);
  const subscriptions = new Map<string, { id: string; names: Set<string>; watcher: FSWatcher }>();
  const missing = new Set<string>();
  const reappeared = (stat: Stats) => { if (stat.nlink) schedule(); };
  let inputs = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        refresh();
      } catch (error) {
        console.error(error);
      }
    }, 20);
  };
  const refresh = () => {
    const paths = new Set<string>();
    run((file) => paths.add(file));
    const directories = new Map<string, Set<string>>();
    const localParents = new Set<string>();
    for (const file of paths) {
      if (inside(root, file)) {
        for (let dir = dirname(file); dir !== root && inside(root, dir) && !localParents.has(dir); dir = dirname(dir)) localParents.add(dir);
        continue;
      }
      for (let child = file; !inside(child, root); child = dirname(child)) {
        const parent = dirname(child);
        if (parent === child) break;
        let names = directories.get(parent);
        if (!names) directories.set(parent, names = new Set());
        names.add(basename(child));
      }
    }
    inputs = new Set([...paths, ...localParents]);
    const present = new Set<string>();
    let changed = false;
    for (const [dir, names] of directories) {
      const stat = statSync(dir, { bigint: true, throwIfNoEntry: false });
      if (!stat?.isDirectory()) continue;
      present.add(dir);
      const id = `${stat.dev}:${stat.ino}`;
      const prior = subscriptions.get(dir);
      if (prior?.id === id) {
        if ([...names].some((name) => !prior.names.has(name))) changed = true;
        prior.names = names;
        continue;
      }
      let watcher: FSWatcher;
      try {
        watcher = watch(dir, { persistent: false }, (_, name) => {
          if (!name || subscriptions.get(dir)?.names.has(name)) schedule();
        });
      } catch (error) {
        if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw error;
        schedule();
        continue;
      }
      watcher.on("error", () => {
        if (subscriptions.get(dir)?.watcher === watcher) subscriptions.delete(dir);
        watcher.close();
        schedule();
      });
      subscriptions.set(dir, { id, names, watcher });
      changed = true;
      prior?.watcher.close();
    }
    for (const [dir, sub] of subscriptions) if (!present.has(dir)) {
      subscriptions.delete(dir);
      sub.watcher.close();
      changed = true;
    }
    const absent = new Set<string>();
    for (const [dir, names] of directories) if (present.has(dir)) {
      for (const name of names) {
        const path = join(dir, name);
        if (existsSync(path)) continue;
        absent.add(path);
        if (missing.has(path)) continue;
        watchFile(path, { persistent: false, interval: 500 }, reappeared);
        missing.add(path);
      }
    }
    for (const path of missing) if (!absent.has(path)) {
      unwatchFile(path, reappeared);
      missing.delete(path);
    }
    if (changed) schedule();
  };
  refresh();
  return {
    change(file?: string) {
      if (!file) { schedule(); return; }
      const absolute = resolve(root, file);
      if (!inside(output, absolute) && (inputs.has(absolute) || changes(file))) schedule();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      for (const sub of subscriptions.values()) sub.watcher.close();
      subscriptions.clear();
      for (const path of missing) unwatchFile(path, reappeared);
      missing.clear();
    },
  };
}

function story(c: Found, p: Plan, from: (file: string) => string): string {
  const uses = (code: string) => p.base.includes(code) || p.stories.some((s) => s.args.includes(code));
  const refuses = p.stories.some((s) => s.refuses);
  const test = [...(refuses ? ["expect"] : []), ...(uses(": fn()") ? ["fn"] : []), ...(refuses ? ["isMockFunction", "userEvent"] : [])];
  const play = (s: Plan["stories"][number]) => {
    const given = s.play && `given.play[${JSON.stringify(s.play)}]`;
    return s.refuses ? (given ? `async (context) => { await ${given}(context); await refuses(context); }` : "refuses") : given;
  };
  const fields = [`id: "${p.id}"`, `title: ${JSON.stringify(p.title)}`, "component", ...(c.meta?.decorator ? ["decorators: [(Story) => given.decorator(() => <Story />)]"] : [])];
  return [
    "// @ts-nocheck",
    `// Generated by vibestack/stories from ${c.name}; edits are lost. Change the component or its .meta file.`,
    ...(test.length ? [`import { ${test.join(", ")} } from "storybook/test";`] : []),
    ...(p.samples ? ['import { Arbitrary, Effect } from "effect";'] : []),
    ...(c.model?.prop ? [`import { initial } from ${from(c.model.file)};`] : []),
    // Under a name no story has: a story's export is capitalized, and a component may be called Empty or Default.
    `import { ${c.name} as component } from ${from(c.file)};`,
    ...(c.meta ? [`import { meta as given } from ${from(c.meta.file)};`] : []),
    "",
    ...(p.samples ? [`const samples = Effect.runSync(Arbitrary.sampleEffect(Arbitrary.schema(given.schema), { count: ${p.samples}, seed: 1 }));`] : []),
    `const base = ${p.base};`,
    "",
    ...(refuses
      ? [
          "/** A disabled or loading story refuses a person: a click, Enter or Space on what it renders calls no spy it was given. */",
          "const refuses = async ({ args, canvasElement }) => {",
          "  // Spies in `base` are shared by every story of the file: count only what this one does.",
          "  for (const value of Object.values(args)) if (isMockFunction(value)) value.mockClear();",
          '  const target = canvasElement.querySelector("a, button, input, select, textarea, [role=button], [role=checkbox], [role=switch], [tabindex]");',
          "  if (target) {",
          "    await userEvent.click(target, { pointerEventsCheck: 0 });",
          "    target.focus();",
          '    await userEvent.keyboard("{Enter} ");',
          "  }",
          "  await expect(Object.keys(args).filter((name) => isMockFunction(args[name]) && args[name].mock.calls.length)).toEqual([]);",
          "};",
          "",
        ]
      : []),
    `export default { ${fields.join(", ")} };`,
    "",
    ...p.stories.map((s) => `export const ${s.export} = { args: ${s.args}${play(s) ? `, play: ${play(s)}` : ""} };`),
    "",
  ].join("\n");
}

/** A Vitest file over every story file: `imports`, then `setup`, then a test of each story whose body is `test`. */
const suite = (files: string[], imports: string[], setup: string[], test: string[]) =>
  [
    "// @ts-nocheck",
    "// Generated by vibestack/stories; edits are lost.",
    ...imports,
    ...files.map((file, i) => `import * as s${i} from ${JSON.stringify(file.startsWith(".") ? file : `./${file}`)};`),
    "",
    ...setup,
    `for (const file of [${files.map((_, i) => `s${i}`).join(", ")}])`,
    "  describe(file.default.title, () => {",
    ...test,
    "  });",
    "",
  ].join("\n");

/** A mount of each story in happy-dom, whatever the package's other tests run in, and its `play` where the metadata gives one or the story is disabled or loading. It shows that a story renders, never that it looks right. */
const smoke = (files: string[]) =>
  suite(files, ["// @vitest-environment happy-dom", 'import { composeStories } from "@storybook/react-vite";', 'import { describe, it } from "vitest";'], [], ["    for (const [name, Story] of Object.entries(composeStories(file))) it(`${name} mounts`, () => Story.run());"]);

/**
 * Each story in a real browser, for Vitest's Browser Mode: it mounts and plays, and axe finds no accessibility
 * violation in it. `preview` is the project's `.storybook/preview`, if any.
 */
const browser = (files: string[], preview: string | undefined) =>
  suite(
    files,
    [
      'import * as a11y from "@storybook/addon-a11y/preview";',
      'import { composeStories, setProjectAnnotations } from "@storybook/react-vite";',
      'import { beforeAll, describe, expect, it } from "vitest";',
      ...(preview ? [`import * as preview from ${preview};`] : []),
    ],
    [
      "// A violation fails its story unless the project's preview sets `parameters.a11y.test` otherwise.",
      `beforeAll(setProjectAnnotations([a11y, { parameters: { a11y: { test: "error" } } }${preview ? ", preview" : ""}]).beforeAll);`,
      "",
    ],
    [
      "    for (const [name, Story] of Object.entries(composeStories(file)))",
      "      it(name, async () => {",
      "        await Story.run();",
      '        const failed = Story.reporting.reports.filter((report) => report.status === "failed").map((report) => report.result);',
      "        for (const result of failed) if (result.error) throw result.error;",
      '        expect(failed.flatMap((result) => result.violations.map((v) => `${v.id}: ${v.help} at ${v.nodes.map((node) => node.target.join(" ")).join(", ")}`))).toEqual([]);',
      "      });",
    ],
  );

/** A generator for one project. Each call brings the output up to date and says what it changed. */
export function generator({ root, out = outOf(root), cap = 12 }: Options): (observe?: (file: string) => void) => Result {
  out = resolve(root, out);
  let configured = new Map<string, string | undefined>();
  let configLookups: Lookup[] = [];
  let build: ReturnType<typeof programs>;
  let previous: { manifest: string; catalog: string; smoke: string; browser: string; preview?: string } | undefined;
  let built: ReturnType<ReturnType<typeof programs>> | undefined;
  const rel = (file: string) => relative(root, file).replaceAll("\\", "/");
  const from = (file: string) => JSON.stringify(relative(out, file).replaceAll("\\", "/").replace(/^(?!\.)/, "./"));
  // A file the Program read is hashed as the Program read it, so an edit made while it ran is seen by the next run.
  const text = (file: string) => built?.program.getSourceFile(file)?.text ?? (built && configured.has(file) ? configured.get(file) : existsSync(file) ? ts.sys.readFile(file) : undefined);
  const hash = (component: string, inputs: string[], observe?: (file: string) => void, read = text) => {
    const sum = createHash("sha1").update(`${VERSION}:${cap}:${rel(out)}`);
    for (const file of inputs) {
      const absolute = join(root, file);
      observe?.(absolute);
      const content = read(absolute);
      if (file === component) {
        const spec = content && modelTag(content);
        const model = spec && modelFile(absolute, spec, observe);
        if (model) sum.update(`model\0${rel(model)}\0`);
      }
      sum.update(`${file}\0${content === undefined ? "-" : "+" + content}\0`);
    }
    return sum.digest("hex");
  };

  /**
   * A component file's inputs: itself, what stands beside it, its package's name, the project's tsconfig, and every
   * source file those reach through imports, by an alias or in another workspace package too, short of `node_modules`.
   */
  const inputsOf = (file: string, names: string[]) => {
    const seen = new Set([file, ...beside(file, names), ...configured.keys()]);
    packageOf(dirname(file), (manifest) => seen.add(manifest));
    const lookups = new Map<string, Lookup>(configLookups.map((lookup) => [lookup[0] + "\0" + lookup[1], lookup]));
    for (const each of seen) {
      const imported = built!.imports.get(each);
      if (!imported) continue;
      for (const dep of imported.files) seen.add(dep);
      for (const lookup of imported.lookups) lookups.set(lookup[0] + "\0" + lookup[1], lookup);
    }
    return { inputs: [...seen].map(rel).sort(), lookups: [...lookups].sort(([a], [b]) => compare(a, b)).map(([, probe]) => probe) };
  };

  return (observe?: (file: string) => void) => {
    built = undefined;
    const manifest = join(out, MANIFEST);
    const saved = existsSync(manifest) ? readFileSync(manifest, "utf8") : undefined;
    const known: Record<string, Entry> = saved === undefined ? {} : JSON.parse(saved);
    const written: string[] = [];
    const write = (name: string, text: string) => {
      if (existsSync(join(out, name)) && readFileSync(join(out, name), "utf8") === text) return;
      writeWhole(join(out, name), text);
      written.push(name);
    };

    const files = sources(root, COMPONENTS);
    const sourceText = new Map<string, string | undefined>();
    const read = (file: string) => {
      if (!sourceText.has(file)) sourceText.set(file, text(file));
      return sourceText.get(file);
    };
    const states = new Map<string, string | boolean | undefined>();
    const valid = ([kind, file, before]: Lookup) => {
      const key = kind + "\0" + file;
      if (!states.has(key)) {
        const absolute = join(root, file);
        observe?.(absolute);
        switch (kind) {
          case "file": states.set(key, ts.sys.fileExists(absolute)); break;
          case "directory": states.set(key, ts.sys.directoryExists(absolute)); break;
          case "realpath": states.set(key, rel(ts.sys.realpath!(absolute))); break;
          case "manifest": {
            const content = read(absolute);
            states.set(key, content === undefined ? undefined : createHash("sha1").update(content).digest("hex"));
            break;
          }
        }
      }
      return states.get(key) === (before ?? false);
    };
    if (!build || !configLookups.every(valid) || [...configured].some(([file, before]) => before !== read(file))) {
      const configs = new Map<string, string | undefined>();
      configLookups = [];
      build = programs(root, configs, configLookups);
      configured = configs;
    }
    let reset = false;
    const fresh = (file: string, entry: Entry | undefined) => {
      if (!entry?.lookups || !entry.lookups.every(valid)) {
        reset = true;
        return false;
      }
      return entry.hash === hash(file, entry.inputs, observe, read) && entry.outputs.every((name) => existsSync(join(out, name)));
    };
    const stale = files.filter((file) => !fresh(rel(file), known[rel(file)]));
    if (stale.length) built = build(files, reset);
    const entries: Record<string, Entry> = {};
    for (const file of files) {
      if (!stale.includes(file)) {
        entries[rel(file)] = known[rel(file)];
        continue;
      }
      const found = analyze(built!.program, file).map((c) => ({ c, p: plan(c, cap) }));
      const { inputs, lookups } = inputsOf(file, found.map(({ c }) => c.name));
      if (observe) for (const [, file] of lookups) observe(join(root, file));
      for (const { c, p } of found) if (p.stories.length) write(`${p.id}.stories.tsx`, story(c, p, from));
      entries[rel(file)] = {
        hash: hash(rel(file), inputs, observe),
        inputs, lookups,
        outputs: found.filter(({ p }) => p.stories.length).map(({ p }) => `${p.id}.stories.tsx`),
        manual: [...new Set(found.flatMap(({ c }) => c.manual ? [rel(c.manual.file)] : []))].sort(compare),
        // As the manifest will give them back: without what JSON cannot hold.
        components: JSON.parse(JSON.stringify(found.map(({ c, p }) => ({
          id: p.id,
          name: c.name,
          package: c.package,
          title: p.title,
          description: c.description,
          source: { file: rel(c.file), line: c.line },
          props: c.props,
          stories: p.catalog,
          ...(c.model ? { model: { spec: c.model.spec, module: c.model.module, state: c.model.state, events: c.model.events } } : {}),
          ...(c.design.length ? { design: c.design } : {}),
          ...(c.part ? { part: c.part } : {}),
          ...(c.children?.length ? { children: c.children } : {}),
          ...(c.citations?.length ? { citations: c.citations } : {}),
          ...(c.uses?.length ? { uses: c.uses } : {}),
          diagnostics: p.diagnostics,
        })))),
      };
    }

    const sorted = Object.values(entries).flatMap((e) => e.components).sort((a, b) => compare(a.id, b.id));
    const index: ComponentIndex = {
      version: 1,
      components: sorted.map((c, i) => (sorted[i - 1]?.id === c.id ? { ...c, diagnostics: [...c.diagnostics, `${c.name}: ${c.package} has two components of this name, and one's stories replace the other's; rename one`] } : c)),
    };
    const outputs = Object.values(entries).flatMap((e) => e.outputs).sort();
    const tested = [...new Set([...outputs, ...Object.values(entries).flatMap((e) => e.manual.map((file) => relative(out, join(root, file)).replaceAll("\\", "/")))])].sort(compare);
    const preview = ["ts", "tsx", "js", "jsx"].map((ext) => join(root, ".storybook", `preview.${ext}`)).find((file) => {
      observe?.(file);
      return existsSync(file);
    });
    if (!previous || previous.manifest !== saved || stale.length || files.length !== Object.keys(known).length || previous.preview !== preview) {
      previous = {
        manifest: `${JSON.stringify(entries)}\n`, catalog: `${JSON.stringify(index, null, 2)}\n`,
        smoke: smoke(tested), browser: browser(tested, preview && from(preview)), preview,
      };
    }
    write("catalog.json", previous.catalog);
    write("stories.test.tsx", previous.smoke);
    write("stories.browser.test.tsx", previous.browser);
    write(MANIFEST, previous.manifest);
    const removed = (existsSync(out) ? readdirSync(out) : []).filter((name) => name.endsWith(".stories.tsx") && !outputs.includes(name));
    for (const name of removed) rmSync(join(out, name));
    return { index, written, removed, analyzed: stale.length, diagnostics: index.components.flatMap((c) => c.diagnostics) };
  };
}
