import fs from "node:fs";
import path from "node:path";
import { BUILTINS, LIST_HELPERS } from "./gen/print.ts";
import { plainText, scanSpec } from "./scan.ts";

/** `defs` are the rule's top-level definitions and types; `locals` the names it binds inside a definition (`val x = …` in a body). */
export interface Rule { key: string; story: string; line: number; prose: string; code: string; defs: string[]; locals: string[] }
/** A rule's own heading, without its story. */
export const heading = (rule: Rule) => rule.key.slice(rule.story.length + 3);
/** A `##` heading: a story or another group of rules. Its prose is the text between the heading and its first rule. */
export interface Story { title: string; line: number; prose: string }
/**
 * One `import` of another spec: `import m.*` (star), `import m.x` (names), `import m as A` (alias), or `import m`,
 * whose names are reached only as `m::x`.
 */
export interface Import { module: string; alias?: string; star: boolean; names: string[] }
export interface SpecReference { target: string; line: number }
interface SpecImport extends Import { target?: string; line: number; column: number; pathLine?: number; pathColumn?: number; pathLength?: number }
const importSources = new WeakMap<Spec, SpecImport[]>();
/**
 * `meaning` is the Quint as written, with every comment, prose included, reduced to a space: what a cache key may
 * depend on. `tangled` is `qnt` before the list helpers were expanded, to map Quint's columns back.
 */
export interface Spec { name: string; file: string; preamble: string; references: SpecReference[]; links: string[]; rules: Rule[]; stories: Story[]; imports: string[]; uses: Import[]; qnt: string; tangled: string; meaning: string; builtins: string[] }
/** The Quint of a spec's imports, theirs first, as far as a cache key may depend on it. */
export const importedMeanings = (spec: Spec, specs: Spec[]): string =>
  spec.imports.map((n) => { const dep = specs.find((x) => x.name === n)!; return importedMeanings(dep, specs) + dep.meaning; }).join("");

/** The specs that ship with the tools (std/net.md); a spec imports one as it would one of its own. */
const PACKAGE = import.meta.dirname;
export const isStd = (file: string) => file.startsWith("std/");
/** Where a spec's file, or its proof file, is: in the project, or in the package for a spec from std/. */
export const located = (root: string, file: string) => path.join(isStd(file) ? PACKAGE : root, file);

/** Why a name cannot name a spec, or undefined if it can. */
export function badSpecName(name: string): string | undefined {
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) return `a spec's file name becomes a module name, so it must look like \`order.md\` or \`orderBook.md\``;
}

/** The relative path gives a unique module name; a nested index names its directory. */
export function specName(file: string): string {
  const parts = file.replaceAll(path.sep, "/").replace(/^(?:spec|std)\//, "").replace(/\.md$/, "").split("/");
  for (const part of parts) {
    const bad = badSpecName(part);
    if (bad) throw new Error(`${file}: ${bad}`);
  }
  if (parts.length > 1 && parts.at(-1) === "index") parts.pop();
  return parts.join("__");
}

/**
 * A spec is Markdown. `##` starts a story (or any grouping), `###` starts a
 * rule, and the ```quint blocks under a rule are its formal half. Tangling
 * keeps every line on its own line number, so Quint errors point into the
 * Markdown file. A fence of any other kind is prose; scan.ts reads the fences.
 */
export function parseSpec(root: string, file: string, text = fs.readFileSync(located(root, file), "utf8")): Spec {
  const name = specName(file);
  const rules: Rule[] = [];
  const stories: Story[] = [];
  const qnt: string[] = [];
  const references: SpecReference[] = [];
  let preamble = "";
  let story: Story | undefined;
  let rule: Rule | undefined;
  // Whether a quint block is open, and its Quint so far, to check that no comment or string runs on past its end.
  let quint = false;
  let block = "";
  // How deeply the Quint so far nests in brackets of any kind, carried from block to block.
  let depth = 0;
  /**
   * Record the definitions of a finished block. Quint lets a body open with `val x = …` and no brace, so a definition
   * at depth 0 counts as a local of the one above it when it is indented further than that one. A misread the other
   * way would hide a dependency from review; `gen` refuses one by comparing with the names Quint declares.
   */
  const declare = (text: string, r: Rule) => {
    const { code } = scan(text);
    let at = 0;
    let top: number | undefined;
    for (const line of text.split("\n")) {
      const indent = line.length - line.trimStart().length;
      const def = line.match(/^\s*(?:pure\s+)?(def|val|type|const)\s+(\w+)/);
      if (def && code[at + indent]) {
        // A type, or the `const` of an opaque function, is never local.
        if (def[1] === "type" || def[1] === "const" || (depth === 0 && (top === undefined || indent <= top))) { r.defs.push(def[2]); if (depth === 0) top = indent; }
        else r.locals.push(def[2]);
      }
      for (let i = 0; i < line.length; i++) if (code[at + i]) depth += "([{".includes(line[i]) ? 1 : ")]}".includes(line[i]) ? -1 : 0;
      depth = Math.max(depth, 0);
      at += line.length + 1;
    }
  };
  // Quint and Markdown may not agree on where a line ends at an odd line break, and prose could then end a comment early.
  scanSpec(plainText(file, text)).forEach(({ text, kind }, i) => {
    if (!story && !rule && kind !== "story" && kind !== "rule") preamble += text + "\n";
    if (kind === "quint") {
      block += text + "\n";
      rule!.code += text + "\n";
      qnt.push(text);
      return;
    }
    if (kind === "close" && quint) {
      // Prose is tangled as `//` comments, which is only safe if no comment or string runs on into it from the code.
      const open = scan(block).mode;
      if (open) throw new Error(`${file}:${i + 1}: a ${open === '"' ? "string" : "comment"} is still open at the end of this quint block; close it inside the block`);
      declare(block, rule!);
      quint = false;
      block = "";
    } else if (kind === "open quint") {
      if (!rule) throw new Error(`${file}:${i + 1}: a quint block must sit under a ### rule`);
      quint = true;
    } else if (kind === "story") {
      story = { title: text.slice(3).trim(), line: i + 1, prose: "" };
      // The ledger records a story under its title, so a second one would share its entry.
      const twin = stories.find((s) => s.title === story!.title);
      if (twin) throw new Error(`${file}:${i + 1}: duplicate story "${story.title}" (also at line ${twin.line}); give each ## heading its own title`);
      stories.push(story);
      rule = undefined;
    } else if (kind === "rule") {
      rule = { key: `${story?.title ?? ""} / ${text.slice(4).trim()}`, story: story?.title ?? "", line: i + 1, prose: "", code: "", defs: [], locals: [] };
      if (rules.some((r) => r.key === rule!.key)) throw new Error(`${file}:${i + 1}: duplicate rule "${rule.key}"`);
      rules.push(rule);
    } else if (kind === "prose" || kind === "fenced") {
      if (kind === "prose") {
        const prose = text.replace(/(`+).*?\1/g, "");
        for (const link of prose.matchAll(/(?<!!)\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g)) {
          const target = link[1] ?? link[2];
          if (!/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target) && (target.endsWith("/") || /\.md(?:[?#]|$)/.test(target) || !path.posix.extname(target)))
            references.push({ target, line: i + 1 });
        }
      }
      if (rule) rule.prose += text + "\n";
      else if (story) story.prose += text + "\n";
    }
    qnt.push(i === 0 ? `module ${name} { // ${text}` : text ? `// ${text}` : "");
  });
  if (quint) {
    if (scan(block).mode) throw new Error(`${file}: a quint block is never closed, and a comment or string in it is still open`);
    declare(block, rule!);
  }
  const tangled = qnt.join("\n");
  // The tangler's own names (expandListHelpers, expandBuiltins) tell the translator what a fold or a call stands for.
  const forged = bareQuint(tangled).split("\n").findIndex((l) => /\bstd_/.test(l));
  if (forged >= 0) throw new Error(`${file}:${forged + 1}: a name beginning std_ is reserved for generated collection operations`);
  try {
    const sources = importsOf(tangled);
    const spec: Spec = { name, file, preamble, references, links: [], rules, stories, imports: sources.map((i) => i.module), uses: sources, qnt: "", tangled, meaning: "", builtins: [] };
    finish(spec, tangled);
    importSources.set(spec, sources);
    return spec;
  } catch (e) {
    throw new Error(`${file}:${(e as Error).message}`, { cause: e });
  }
}

/** Set what follows from a spec's final Quint: the text Quint reads, the definitions added for builtins, and its meaning. */
function finish(spec: Spec, text: string) {
  const expanded = expandBuiltins(expandListHelpers(text), spec.name);
  spec.qnt = expanded.text + "\n}\n";
  spec.builtins = expanded.names;
  spec.meaning = codeOnly(text);
}

/** Which characters of Quint are code, as opposed to part of a string or a comment, which are comments, and what is still open at the end. */
function scan(text: string): { code: boolean[]; comment: boolean[]; strings: Set<number>; mode: "" | '"' | "//" | "/*" } {
  const code: boolean[] = [];
  const comment: boolean[] = [];
  const strings = new Set<number>();
  let mode: "" | '"' | "//" | "/*" = "";
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (mode === "" && text[i] === '"') { strings.add(i); mode = '"'; }
    else if (mode === "" && two === "//") { comment[i] = comment[i + 1] = true; i++; mode = "//"; }
    else if (mode === "" && two === "/*") { comment[i] = comment[i + 1] = true; i++; mode = "/*"; }
    else if (mode === "") code[i] = true;
    else if (mode === '"' && text[i] === "\\") i++;
    else if (mode === '"' && text[i] === '"') mode = "";
    else if (mode === "//" && text[i] === "\n") mode = "";
    else if (mode === "//") comment[i] = true;
    else if (mode === "/*" && two === "*/") { comment[i] = comment[i + 1] = true; i++; mode = ""; }
    else if (mode === "/*") comment[i] = true;
  }
  return { code, comment, strings, mode: mode === "//" ? "" : mode };
}

/** Imports keep their positions even when whitespace or comments split the declaration. */
function importsOf(text: string): SpecImport[] {
  const { code, strings } = scan(text);
  const tokens: { text: string; index: number }[] = [];
  const word = /[A-Za-z_]\w*|[.*]/y;
  for (let i = 0; i < text.length; i++) {
    if (strings.has(i)) {
      let end = i + 1;
      for (; end < text.length; end++) { if (text[end] === "\\") end++; else if (text[end] === '"') break; }
      tokens.push({ text: text.slice(i, end + 1), index: i });
      i = end;
    } else if (code[i]) {
      word.lastIndex = i;
      const token = word.exec(text);
      if (token) { tokens.push({ text: token[0], index: i }); i += token[0].length - 1; }
    }
  }
  const position = (offset: number) => ({ line: text.slice(0, offset).split("\n").length, column: offset - text.lastIndexOf("\n", offset - 1) - 1 });
  return tokens.flatMap((token, i): SpecImport[] => {
    if (token.text !== "import" || !code[token.index]) return [];
    const name = tokens[i + 1];
    if (!name || !/^[A-Za-z_]\w*$/.test(name.text)) return [];
    let at = i + 2;
    let alias: string | undefined;
    let selector: string | undefined;
    if (tokens[at]?.text === ".") { selector = tokens[at + 1]?.text; at += 2; }
    else if (tokens[at]?.text === "as") { alias = tokens[at + 1]?.text; at += 2; }
    const target = tokens[at]?.text === "from" && strings.has(tokens[at + 1]?.index) ? tokens[at + 1] : undefined;
    const point = target && position(target.index);
    return [{ module: name.text, alias, star: selector === "*", names: selector && selector !== "*" ? [selector] : [], ...position(name.index),
      ...(target && point ? { target: JSON.parse(target.text) as string, pathLine: point.line, pathColumn: point.column, pathLength: target.text.length } : {}) }];
  });
}

/**
 * Quint with every comment reduced to one space, line breaks kept and no space at the end of a line: what it means,
 * whatever the comments say. Strings are kept whole, and a comment still separates the tokens around it.
 */
function codeOnly(text: string): string {
  const { comment } = scan(text);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (!comment[i] || text[i] === "\n") out += text[i];
    else if (!comment[i - 1] || text[i - 1] === "\n") out += " ";
  }
  return out.replace(/[ \t]+$/gm, "");
}

/**
 * Rewrite `xs.every(x => e)`, `.some`, `.listMap` and `.includes(v)` into Quint's
 * built-in `foldl`, in place and without moving a line (see LIST_HELPERS in
 * gen/print.ts for why). Strings and comments are left alone.
 */
export function expandListHelpers(text: string): string {
  const { code } = scan(text);
  let count = 0;
  /** The line breaks of a piece of text that is dropped, so that no line moves. */
  const breaks = (s: string) => s.replace(/[^\n]/g, "");
  const expand = (from: number, to: number): string => {
    const call = new RegExp(`\\.(${Object.keys(LIST_HELPERS).join("|")})\\(`, "g");
    let out = "";
    let at = from;
    call.lastIndex = from;
    for (let m; (m = call.exec(text)) && m.index < to; ) {
      if (!code[m.index]) continue;
      let end = call.lastIndex;
      for (let depth = 1; depth; end++) {
        if (end >= to) throw new Error(`${text.slice(0, m.index).split("\n").length}: no closing parenthesis for .${m[1]}(`);
        if (code[end] && text[end] === "(") depth++;
        else if (code[end] && text[end] === ")") depth--;
      }
      const arg = expand(call.lastIndex, end - 1);
      const n = count++;
      const acc = `std_${m[1]}_${n}`;
      const lambda = arg.match(/^(\s*\(?\s*(\w+)\s*\)?\s*=>)([\s\S]*)$/);
      const item = m[1] === "includes" || !lambda ? `std_x_${n}` : lambda[2];
      const body = m[1] === "includes" ? `${item} == (${arg})`
        : lambda ? breaks(lambda[1]) + lambda[3]
        : `${breaks(arg.match(/^\s*/)![0])}${arg.trim()}(${item})${breaks(arg.match(/\s*$/)![0])}`;
      out += `${text.slice(at, m.index)}.foldl(${LIST_HELPERS[m[1]].init}, (${acc}, ${item}) => ${LIST_HELPERS[m[1]].step(acc, body)})`;
      at = call.lastIndex = end;
    }
    return out + text.slice(at, to);
  };
  return expand(0, text.length);
}

/**
 * Where a column Quint reports on an expanded line of `qnt` lies on the line as tangled: the same column before the
 * first rewrite, shifted after the last, and undefined inside a rewrite, where no column of the original matches.
 */
export function originalColumn(tangled: string, qnt: string, line: number, col: number): number | undefined {
  const was = tangled.split("\n")[line] ?? "";
  const is = qnt.split("\n")[line] ?? "";
  if (was === is) return col;
  let head = 0;
  while (head < was.length && head < is.length && was[head] === is[head]) head++;
  if (col < head) return col;
  let tail = 0;
  while (tail < was.length - head && tail < is.length - head && was[was.length - 1 - tail] === is[is.length - 1 - tail]) tail++;
  return col >= is.length - tail ? col - (is.length - was.length) : undefined;
}

/** Quint with every string and comment blanked out, line breaks kept. */
export const bareQuint = (text: string) => { const { code } = scan(text); return text.replace(/[^\n]/g, (c, i) => (code[i] ? c : " ")); };

/** Expand total collection operations without moving the source lines. */
function expandBuiltins(text: string, module: string): { text: string; names: string[] } {
  const { code } = scan(text);
  const used = new Set<string>();
  const renamed = text.replace(/\.(\w+)\s*\(/g, (call, name: string, at: number) => (code[at] && Object.hasOwn(BUILTINS, name) ? (used.add(name), `.std_${name}_${module}(`) : call));
  return { text: renamed + [...used].map((n) => `\npure def std_${n}_${module}${BUILTINS[n]}`).join(""), names: [...used].map((n) => `std_${n}_${module}`) };
}

/** All Markdown sources under spec/, without reading unfinished contents. */
export function specFiles(root: string): string[] {
  const dir = path.join(root, "spec");
  const files: string[] = [];
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${path.relative(root, file)}: specs and their directories cannot be symbolic links`);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path.relative(root, file).split(path.sep).join("/"));
    }
  };
  if (fs.existsSync(dir)) {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("spec/: the spec directory cannot be a symbolic link");
    walk(dir);
  }
  return files;
}

/** Every spec after its imports; text snapshots also support Studio's unpublished changes. */
export function readSpecs(root: string, texts?: Record<string, string>): Spec[] {
  const files = texts ? Object.keys(texts).sort() : specFiles(root);
  if (!files.length) throw new Error(`there are no specs: ${path.join(root, "spec")} holds no .md file`);
  const all: Spec[] = [];
  const byFile = new Map<string, Spec>();
  const byName = new Map<string, Spec>();
  const add = (spec: Spec) => {
    const previous = byName.get(spec.name);
    if (previous) throw new Error(`${previous.file} and ${spec.file} have the same module name ${spec.name}; keep only one`);
    all.push(spec);
    byFile.set(spec.file, spec);
    byName.set(spec.name, spec);
    return spec;
  };
  for (const file of files) add(parseSpec(root, file, texts?.[file]));
  const resolve = (spec: Spec, target: string, line: number, library = false): Spec => {
    const fail = (reason: string): never => { throw new Error(`${spec.file}:${line}: ${target}: ${reason}`); };
    let link: string;
    try { link = decodeURIComponent(target.split(/[?#]/, 1)[0]); } catch { return fail("invalid path encoding"); }
    if (!link || link.includes("\\") || link.includes("\0") || path.posix.isAbsolute(link) || /^[a-z][a-z0-9+.-]*:/i.test(link)) return fail("use a relative path within spec/");
    const scope = isStd(spec.file) ? "std" : "spec";
    const dest = path.posix.normalize(path.posix.join(path.posix.dirname(spec.file), link)).replace(/\/$/, "");
    if (dest !== scope && !dest.startsWith(`${scope}/`)) return fail(`the target must stay within ${scope}/`);
    const candidates = path.posix.extname(dest) ? [dest] : [`${dest}.md`, `${dest}/index.md`];
    const found = candidates.map((file) => byFile.get(file)).filter((s) => s !== undefined);
    if (!found.length && (library || isStd(spec.file))) {
      // A bare sibling import may name a library shipped with the tools, after the local path was tried.
      const sibling = link.match(/^(?:\.\/)?([a-z][A-Za-z0-9]*)(?:\.md)?$/);
      const bundled = isStd(spec.file) ? candidates : sibling ? [`std/${sibling[1]}.md`] : [];
      for (const file of bundled) if (fs.existsSync(located(root, file))) found.push(byFile.get(file) ?? add(parseSpec(root, file)));
    }
    if (found.length !== 1) return fail(found.length ? "the path is ambiguous: name the .md file" : "no spec at this path (a directory needs index.md)");
    return found[0];
  };
  for (const spec of all) {
    const lines = spec.tangled.split("\n");
    const replacements: { line: number; column: number; length: number; value: string }[] = [];
    const imports = importSources.get(spec) ?? [];
    spec.uses = imports.map((imported) => {
      if (!imported.target) throw new Error(`${spec.file}:${imported.line}: import ${imported.module} needs a relative from path`);
      const dep = resolve(spec, imported.target, imported.line, true);
      const implicitAlias = !imported.alias && !imported.star && !imported.names.length && dep.name !== imported.module ? imported.module : undefined;
      replacements.push({ line: imported.pathLine!, column: imported.pathColumn!, length: imported.pathLength!, value: JSON.stringify(`./${dep.name}`) },
        { line: imported.line, column: imported.column, length: imported.module.length, value: implicitAlias ? `${dep.name} as ${implicitAlias}` : dep.name });
      return { module: dep.name, alias: imported.alias ?? implicitAlias, star: imported.star, names: imported.names };
    });
    spec.imports = spec.uses.map((i) => i.module);
    for (const { line, column, length, value } of replacements.sort((a, b) => b.line - a.line || b.column - a.column))
      lines[line - 1] = lines[line - 1].slice(0, column) + value + lines[line - 1].slice(column + length);
    if (replacements.length) finish(spec, lines.join("\n"));
    spec.links = [...new Set(spec.references.map(({ target, line }) => resolve(spec, target, line).file))];
  }
  const ordered: Spec[] = [];
  const visit = (spec: Spec, trail: string[]) => {
    if (ordered.includes(spec)) return;
    if (trail.includes(spec.name)) throw new Error(`specs import each other in a circle: ${[...trail, spec.name].join(" -> ")}`);
    for (const name of spec.imports) visit(byName.get(name)!, [...trail, spec.name]);
    ordered.push(spec);
  };
  all.forEach((spec) => visit(spec, []));
  return ordered;
}
