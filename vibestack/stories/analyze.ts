// Reads React components with the TypeScript checker: what each takes, what its metadata file gives, and
// the spec model it shows. One Program serves every file, and the next run reuses it.
import { existsSync, globSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import ts from "typescript";
import { owner } from "../util.ts";

/** A value in a metadata file that only running it would give, such as JSX or a function. */
const dynamic = Symbol("dynamic");

export interface Prop {
  name: string;
  kind: "boolean" | "number" | "string" | "union" | "function" | "node" | "object" | "array" | "unknown";
  required: boolean;
  options?: (string | number | boolean)[];
  default?: unknown;
  description?: string;
}
type Values = Record<string, unknown>;
/** A `<Component>.meta.ts(x)` as far as it can be read without running it (meta.ts, `ComponentMeta`). */
interface Meta {
  file: string;
  args: Values;
  examples: Record<string, Values>;
  states: Record<string, Values>;
  /** As written: a pair of numbers, when the file is right. */
  bounds: Values;
  /** Whether `args` holds more than was read: a spread, a computed name or a call. */
  open: boolean;
  /** The props its schema covers, when it has one. */
  schema?: string[];
  decorator: boolean;
  play: string[];
  /** Fields `ComponentMeta` does not have, which nothing reads. */
  extra: string[];
}
/** A hand-written `<Component>.stories.tsx`: its stories replace generated ones of the same name. */
interface Manual { file: string; id?: string; title?: string; exports: string[] }
interface Model { spec: string; module: string; state: string; events: string[]; file: string; prop?: string; initial: unknown }
export interface Found {
  name: string;
  file: string;
  line: number;
  description: string;
  package: string;
  props: Prop[];
  meta?: Meta;
  manual?: Manual;
  model?: Model;
  /** Why its `@model` tag gave no model: the spec it names has no generated state to show. */
  unlinked?: string;
  design: string[];
  /** The props it only inherits: declared by a library or the DOM, not in the project's source. */
  inherited: string[];
  /** The component this one only works inside, when its file is named after another of its exports. */
  part?: string;
  /** Sorted unique capitalized JSX component names rendered in this component's body. */
  children?: string[];
  /** Deduplicated spec citations found in this component's source file. */
  citations?: { spec: string; heading: string }[];
  /** Sorted unique value identifiers imported from `gen/*.ts` or `gen/*.effect.vibe` in this file. */
  uses?: string[];
}

/** The package a directory belongs to: the nearest `package.json` above it. */
export function packageOf(dir: string): { name: string; dir: string } {
  const file = join(dir, "package.json");
  if (existsSync(file)) return { name: JSON.parse(readFileSync(file, "utf8")).name ?? basename(dir), dir };
  return dirname(dir) === dir ? { name: basename(dir), dir } : packageOf(dirname(dir));
}

/** `spec/billing/index.md` is `billing`, `spec/billing/payments.md` is `billing__payments` (SPEC.md, "Writing a spec"). */
const moduleOf = (spec: string) => spec.replace(/^(\.\/)?spec\//, "").replace(/\.md$/, "").replace(/\/index$/, "").replaceAll("/", "__");
/**
 * The generated module of `spec`: in the component's own package, or, for a shared package such as a component
 * library, in the spec's owner, else the root's (SPEC.md, "One spec tree").
 */
export const modelFile = (abs: string, spec: string): string | undefined => {
  const own = packageOf(dirname(abs)).dir, name = `${moduleOf(spec)}.ts`;
  const root = ancestors(own).find((dir) => existsSync(join(dir, spec)));
  const dir = root && owner(root, spec.replace(/^\.\//, ""));
  const candidates = [join(own, "gen", name), ...(root && dir ? [join(root, dir, "gen", name)] : []), ...(root ? [join(root, "gen", name)] : [])];
  return candidates.find(existsSync);
};
const ancestors = (dir: string): string[] => (dirname(dir) === dir ? [dir] : [dir, ...ancestors(dirname(dir))]);
export const modelTag = (text: string) => /@model\s+(\S+)/.exec(text)?.[1];

/** The component files the globs name, sorted: never tests, stories, metadata or anything installed. */
export function sources(root: string, globs: string[]): string[] {
  const skip = /(^|\/)(node_modules|\.[^/]+)\/|\.(test|spec|stories|meta)\.tsx?$|\.d\.ts$/;
  return globSync(globs, { cwd: root }).map((file) => file.replaceAll("\\", "/")).filter((file) => file.endsWith(".tsx") && !skip.test(file)).sort().map((file) => join(root, file));
}

/** Plain order of text, the same on every machine. */
export const compare = (a: string, b: string) => Number(a > b) - Number(a < b);

/** Where `<name>.meta.ts(x)` or `<name>.stories.ts(x)` would stand beside a component. */
const sibling = (abs: string, name: string, kind: "meta" | "stories") => ["tsx", "ts"].map((ext) => join(dirname(abs), `${name}.${kind}.${ext}`));

/** The files beside a component that change its stories, present or not: metadata, hand-written stories, its model. */
export function beside(abs: string, names: string[]): string[] {
  const spec = existsSync(abs) ? modelTag(readFileSync(abs, "utf8")) : undefined;
  const model = spec && modelFile(abs, spec);
  return [...names.flatMap((name) => [...sibling(abs, name, "meta"), ...sibling(abs, name, "stories")]), ...(model ? [model] : [])];
}

/**
 * Builds Programs over a project's components, their metadata and their models. Each reuses what the last
 * one parsed, so a rebuild reads only the files that changed.
 */
export function programs(root: string): (files: string[]) => ts.Program {
  const fail = (problem: ts.Diagnostic) => {
    throw new Error(ts.flattenDiagnosticMessageText(problem.messageText, "\n"));
  };
  const given = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: fail })!.options;
  const options: ts.CompilerOptions = { ...given, jsx: given.jsx ?? ts.JsxEmit.ReactJSX, noEmit: true, skipLibCheck: true };
  const host = ts.createCompilerHost(options, true);
  const parse = host.getSourceFile;
  const parsed = new Map<string, { stamp: string; file: ts.SourceFile | undefined }>();
  host.getSourceFile = (name, ...rest) => {
    const stamp = `${ts.sys.getModifiedTime?.(name)?.getTime()}:${ts.sys.getFileSize?.(name)}`;
    if (parsed.get(name)?.stamp !== stamp) parsed.set(name, { stamp, file: parse(name, ...rest) });
    return parsed.get(name)!.file;
  };
  let last: ts.Program | undefined;
  return (files) => {
    const metas = [...new Set(files.map(dirname))].flatMap((dir) => readdirSync(dir).filter((name) => /\.meta\.tsx?$/.test(name)).map((name) => join(dir, name)));
    const models = files.flatMap((file) => beside(file, []).filter((input) => input.endsWith(".ts") && existsSync(input)));
    return (last = ts.createProgram({ rootNames: [...new Set([...files, ...metas, ...models])], options, host, oldProgram: last }));
  };
}

const key = (name: ts.PropertyName) => (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined);
const declared = (file: ts.SourceFile, name: string) =>
  file.statements.flatMap((s) => (ts.isVariableStatement(s) ? [...s.declarationList.declarations] : [])).find((d) => d.name.getText() === name);
const exported = (s: ts.Statement) => ts.canHaveModifiers(s) && ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** An expression without its parentheses, `as`, `satisfies` and `!`. */
function bare(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  return node;
}

/** The value an expression writes out, following names declared at the top of its file; `dynamic` where it has to run. */
function literal(given: ts.Expression | undefined): unknown {
  if (!given) return undefined;
  const node = bare(given);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return node.kind === ts.SyntaxKind.TrueKeyword;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const n = literal(node.operand);
    return typeof n === "number" ? -n : dynamic;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map(literal);
    return items.includes(dynamic) ? dynamic : items;
  }
  if (ts.isObjectLiteralExpression(node))
    return Object.fromEntries(
      node.properties.flatMap((p): [PropertyKey, unknown][] => {
        const name = p.name && key(p.name);
        // A spread or a computed name is marked, under a key no listing or JSON shows.
        return name === undefined ? [[dynamic, true]] : [[name, ts.isPropertyAssignment(p) ? literal(p.initializer) : ts.isShorthandPropertyAssignment(p) ? literal(p.name) : dynamic]];
      }),
    );
  if (!ts.isIdentifier(node)) return dynamic;
  const named = declared(node.getSourceFile(), node.text)?.initializer;
  return named ? literal(named) : node.text === "undefined" ? undefined : dynamic;
}

const record = (value: unknown): Values => (value && typeof value === "object" && !Array.isArray(value) ? (value as Values) : {});
const records = (value: unknown) => Object.fromEntries(Object.entries(record(value)).map(([name, v]) => [name, record(v)]));

/** The fields of `ComponentMeta` (meta.ts). */
const FIELDS = ["args", "examples", "states", "bounds", "schema", "decorator", "play"];

function readMeta(checker: ts.TypeChecker, file: ts.SourceFile): Meta | undefined {
  const node = declared(file, "meta")?.initializer;
  const object = node && bare(node);
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const meta = record(literal(object));
  const schema = object.properties.find((p) => p.name && key(p.name) === "schema");
  const covered = schema && checker.getTypeAtLocation(schema).getProperty("Type");
  return {
    file: file.fileName,
    args: record(meta.args),
    examples: records(meta.examples),
    states: records(meta.states),
    bounds: record(meta.bounds),
    open: meta.args === dynamic || dynamic in record(meta.args),
    schema: schema && (covered ? checker.getTypeOfSymbol(covered).getProperties().map((p) => p.name) : []),
    decorator: "decorator" in meta,
    play: Object.keys(record(meta.play)),
    extra: Object.keys(meta).filter((name) => !FIELDS.includes(name)),
  };
}

function readManual(file: string): Manual {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const main = record(literal(source.statements.find(ts.isExportAssignment)?.expression));
  const names = source.statements.flatMap((s) => (!exported(s) ? [] : ts.isVariableStatement(s) ? s.declarationList.declarations.map((d) => d.name.getText()) : ts.isFunctionDeclaration(s) && s.name ? [s.name.text] : []));
  return { file, id: typeof main.id === "string" ? main.id : undefined, title: typeof main.title === "string" ? main.title : undefined, exports: names };
}

/** A generated module as a model: its state is the type of `initial`, its events the `type`s of `Event`. */
function readModel(checker: ts.TypeChecker, file: ts.SourceFile, spec: string): { model: Model; state: ts.Type } | undefined {
  const namespace = checker.getSymbolAtLocation(file);
  if (!namespace) return;
  const exports = new Map(checker.getExportsOfModule(namespace).map((s) => [s.name, s]));
  const initial = exports.get("initial");
  const event = exports.get("Event");
  if (!initial) return undefined;
  const state = checker.getTypeOfSymbol(initial);
  const events = event ? checker.getDeclaredTypeOfSymbol(event) : undefined;
  const names = (events?.isUnion() ? events.types : events ? [events] : []).flatMap((t) => {
    const tag = t.getProperty("type");
    const of = tag && checker.getTypeOfSymbol(tag);
    return of?.isStringLiteral() ? [of.value] : [];
  });
  return { model: { spec, module: moduleOf(spec), state: checker.typeToString(state), events: names, file: file.fileName, initial: literal(declared(file, "initial")?.initializer) }, state };
}

/** What a prop takes. A union's options come in the order its declaration writes them, whatever order the checker made them in. */
function shape(checker: ts.TypeChecker, type: ts.Type, text: string): Pick<Prop, "kind" | "options"> {
  const whole = checker.getNonNullableType(type);
  const parts = whole.isUnion() ? whole.types : [whole];
  const all = (flags: ts.TypeFlags) => parts.every((t) => t.flags & flags);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { kind: "unknown" };
  if (whole.getCallSignatures().length) return { kind: "function" };
  if (checker.isArrayType(whole) || checker.isTupleType(whole)) return { kind: "array" };
  if (parts.some((t) => /^(ReactElement|ReactPortal|Element)$/.test((t.aliasSymbol ?? t.symbol)?.name ?? ""))) return { kind: "node" };
  if (all(ts.TypeFlags.BooleanLike)) return { kind: "boolean" };
  if (all(ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral)) {
    const options = parts.map((t) => (t.isLiteral() ? (t.value as string | number) : checker.typeToString(t) === "true"));
    const at = (option: unknown) => {
      const found = new RegExp(`(?<![\\w-])${String(option).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).exec(text);
      return found ? found.index : Infinity;
    };
    return { kind: "union", options: options.sort((a, b) => at(a) - at(b) || (typeof a === "number" && typeof b === "number" ? a - b : compare(String(a), String(b)))) };
  }
  if (all(ts.TypeFlags.NumberLike)) return { kind: "number" };
  // Text or a number, such as an input's `value`, is given as text.
  if (all(ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike)) return { kind: "string" };
  return { kind: all(ts.TypeFlags.Object | ts.TypeFlags.Intersection) ? "object" : "unknown" };
}

/** The function a component is, through `forwardRef(…)` and `memo(…)`. */
function body(decl: ts.Declaration): ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | undefined {
  let node: ts.Node | undefined = ts.isVariableDeclaration(decl) ? decl.initializer : decl;
  while (node && ts.isExpression(node)) {
    const unwrapped = bare(node);
    if (!ts.isCallExpression(unwrapped)) {
      node = unwrapped;
      break;
    }
    node = unwrapped.arguments[0];
  }
  return node && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) ? node : undefined;
}

const CITATION = /(?<![\w/.-])(spec\/(?:[A-Za-z0-9]+\/)*[A-Za-z0-9]+\.md), "([^"]+)"/g;
const GEN_MODULE = /(?:^|\/)gen\/[^/]+\.(?:ts|effect\.vibe)$/;

function readCitations(text: string): { spec: string; heading: string }[] {
  if (!text.includes("spec/")) return [];
  const seen = new Set<string>();
  const out: { spec: string; heading: string }[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("spec/")) continue;
    for (const [, spec, heading] of line.matchAll(CITATION)) {
      const id = `${spec}\0${heading}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ spec, heading });
    }
  }
  return out;
}

function genUses(file: ts.SourceFile): string[] {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!GEN_MODULE.test(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    else for (const element of bindings.elements) if (!element.isTypeOnly) names.add(element.propertyName?.text ?? element.name.text);
  }
  return [...names].sort(compare);
}

function jsxChildren(decl: ts.Declaration, self: string): string[] {
  const root = body(decl)?.body;
  if (!root) return [];
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      const name = ts.isIdentifier(tag) ? tag.text : ts.isPropertyAccessExpression(tag) && tag.name.text !== "Fragment" ? tag.getText() : "";
      if (/^[A-Z]/.test(name) && name !== "Fragment" && name !== self) names.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return [...names].sort(compare);
}

/** `defaultVariants` of the `cva(…)` call a variant prop was declared in. */
function variantDefaults(decl: ts.Node | undefined): Values {
  const call = decl && ts.findAncestor(decl, (n): n is ts.CallExpression => ts.isCallExpression(n) && n.expression.getText() === "cva");
  return record(record(literal(call?.arguments[1])).defaultVariants);
}

/** A prop a state story needs even when the component only passes it through to its element. */
export const STATE = /^(disabled|loading|error|invalid)$/;

/** Every exported component of one file: a capitalized export that is a function returning an element. */
export function analyze(built: ts.Program, abs: string): Found[] {
  const checker = built.getTypeChecker();
  const file = built.getSourceFile(abs);
  const module = file && checker.getSymbolAtLocation(file);
  if (!file || !module) return [];
  const own = (d: ts.Declaration) => !built.isSourceFileFromExternalLibrary(d.getSourceFile()) && !built.isSourceFileDefaultLibrary(d.getSourceFile());
  const spec = modelTag(file.text);
  const model = spec && modelFile(abs, spec);
  const gen = model && built.getSourceFile(model);
  const citations = readCitations(file.text);
  const uses = genUses(file);

  const found = checker.getExportsOfModule(module).flatMap((exportOf): Found[] => {
    const symbol = exportOf.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exportOf) : exportOf;
    const decl = symbol.valueDeclaration;
    if (!/^[A-Z]/.test(exportOf.name) || !decl || decl.getSourceFile() !== file) return [];
    const signature = checker.getTypeOfSymbolAtLocation(symbol, decl).getCallSignatures()[0];
    if (!signature || !/Element|ReactNode|^any$/.test(checker.typeToString(signature.getReturnType()))) return [];

    const tags = (name: string) => symbol.getJsDocTags(checker).filter((t) => t.name === name).map((t) => ts.displayPartsToString(t.text).trim());
    const metaSource = sibling(abs, exportOf.name, "meta").map((path) => built.getSourceFile(path)).find(Boolean);
    const meta = metaSource && readMeta(checker, metaSource);
    const manual = sibling(abs, exportOf.name, "stories").find(existsSync);
    const { model, state } = (gen && tags("model").length ? readModel(checker, gen, spec) : undefined) ?? {};

    const binding = body(decl)?.parameters[0]?.name;
    const taken = new Map((binding && ts.isObjectBindingPattern(binding) ? binding.elements : []).filter((e) => !e.dotDotDotToken).map((e) => [(e.propertyName ?? e.name).getText(), e.initializer]));
    const mentioned = new Set([...Object.keys(meta?.args ?? {}), ...Object.values(meta?.examples ?? {}).flatMap((example) => Object.keys(example)), ...Object.keys(meta?.bounds ?? {}), ...(meta?.schema ?? [])]);
    const first = signature.parameters[0];
    const symbols = (first ? checker.getPropertiesOfType(checker.getTypeOfSymbolAtLocation(first, decl)) : [])
      // `children` is kept even when the component only passes it on with the rest: it is what most of them show.
      .filter((p) => p.name === "children" || taken.has(p.name) || mentioned.has(p.name) || STATE.test(p.name) || p.declarations?.some(own));
    const props = symbols.map((p): Prop => {
      const type = checker.getTypeOfSymbolAtLocation(p, decl);
      const at = p.declarations?.find(own);
      const written = at && ts.isPropertySignature(at) && at.type ? checker.getTypeFromTypeNode(at.type).aliasSymbol?.declarations?.[0] : undefined;
      const preset = taken.get(p.name) ? literal(taken.get(p.name)) : variantDefaults(at)[p.name];
      if (model && checker.getNonNullableType(type) === state) model.prop ??= p.name;
      const description = ts.displayPartsToString(p.getDocumentationComment(checker));
      return {
        name: p.name,
        ...shape(checker, type, (written ?? at)?.getText() ?? ""),
        required: !(p.flags & ts.SymbolFlags.Optional),
        ...(preset !== undefined && preset !== dynamic ? { default: preset } : {}),
        ...(description ? { description } : {}),
      };
    });
    const children = jsxChildren(decl, exportOf.name);
    return [{
      name: exportOf.name,
      file: abs,
      line: file.getLineAndCharacterOfPosition(decl.getStart()).line + 1,
      description: ts.displayPartsToString(symbol.getDocumentationComment(checker)),
      package: packageOf(dirname(abs)).name,
      props,
      meta,
      manual: manual ? readManual(manual) : undefined,
      model,
      // A module not generated yet is not stateless: its spec's `gen` may simply not have run.
      ...(gen && tags("model").length && !model ? { unlinked: `@model ${spec} has no state to show: ${moduleOf(spec!)}.ts exports no \`initial\`; name the spec whose model holds what it shows` } : {}),
      design: tags("design"),
      inherited: symbols.filter((p) => !p.declarations?.some(own)).map((p) => p.name),
      ...(children.length ? { children } : {}),
      ...(citations.length ? { citations } : {}),
      ...(uses.length ? { uses } : {}),
    }];
  });
  const whole = basename(abs).replace(/\.tsx?$/, "");
  return found.some((c) => c.name === whole) ? found.map((c) => (c.name === whole ? c : { ...c, part: whole })) : found;
}
