import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type * as TS from "typescript";
import { InstallationChanged } from "../installed.ts";
import { isStd, type Spec } from "../parse.ts";
import { exec } from "../run.ts";
import { citations, companions, fileCitations, HAS_CITATION, indent, isTestFile, manifest, missingCitations, owner, packageCode, packageManager, packageScripts, testInputs, testReceipt, tokenize, tsApi, type Citation, type Remember, type Reported } from "../util.ts";
import type { TestProfile } from "./profile.ts";

/** The configuration every package shares (vibestack/testing/vitest.ts): `spec init` writes it, and `check` where test/ has nothing to run it. */
export const VITEST_CONFIG = `import { project } from "vibestack/testing/vitest";\n\nexport default project({ root: import.meta.dirname });\n`;

/**
 * The tests stage of one of `codeDirs`: the rules its tests are held to, then its own `test` script, run in its
 * directory. A pass is remembered until something the tests read changes; in a `check` that Turborepo runs, which
 * waits for the package's `test`, the script has just run and is not run again.
 */
export async function tests(checking: string, dir: string, specs: Spec[], remember: Remember, mode: TestProfile = "normal", fresh = false): Promise<Reported<"tests">[]> {
  const said: Reported<"tests">[] = [];
  const root = path.join(checking, dir);
  try {
    const codeEntries = packageCode(root).map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")] as const);
    const dirCitations = codeEntries.flatMap(([file, text]) => fileCitations(dir + file, text));
    const dangling = missingCitations(specs, dirCitations);
    if (dangling.length) said.push([false, "tests", `${dangling.length} citations name no story or rule of the spec`, indent(dangling.join("\n"))]);
    const oracle = driverImports(root, codeEntries.filter(([file]) => file.startsWith("test/drivers/"))).map((problem) => dir + problem);
    if (oracle.length) said.push([false, "tests", "a driver imports gen/ as types only: it reaches the application, and the spec is the oracle the traces stage compares it with", indent(oracle.join("\n"))]);
    said.push(...testRules(checking, dir, specs, codeEntries.filter(([file]) => isTestFile(file)), dirCitations));
    // The package's own tests, in whatever runner it chose (AGENTS.md, "Tests"). test/ with nothing to run it gets
    // Vitest, as `spec init` sets it up; the placeholder `npm init` writes is no script.
    const scripts = packageScripts(root);
    let script = /no test specified/.test(scripts.test ?? "") ? undefined : scripts.test;
    if (!script && fs.existsSync(path.join(root, "test"))) {
      said.push([true, "tests", addVitest(root)]);
      script = "vitest run";
    }
    if (!script) return said;
    const manager = packageManager(root);
    const fingerprint = testInputs(root, mode);
    if (!fresh && fingerprint !== undefined) {
      try {
        if (JSON.parse(fs.readFileSync(testReceipt(root, mode), "utf8")).fingerprint === fingerprint) {
          said.push([true, "tests", "pass: the test runner recorded success for these inputs"]);
          return said;
        }
      } catch { /* no matching successful test run */ }
    }
    const runTests = async (): Promise<Reported<"tests">> => {
      const { NODE_TEST_CONTEXT: _, ...env } = process.env;
      // The root that is checking: spec.ts refuses a check of it, or of a package below it, started from these tests.
      const t = await exec(manager.name, ["run", "test", ...(mode === "nightly" ? ["--mode", "nightly"] : [])], root, { ...env, SPEC_TESTS: fs.realpathSync(checking) });
      const ok = t.status === 0 && !t.stopped;
      // From the runner's list of failures, Vitest's or Node's, at most 200 lines of it; else the end of what it said.
      const stdout = stripVTControlCharacters(t.stdout), stderr = stripVTControlCharacters(t.stderr);
      const lines = `${stdout}${stderr}`.split("\n");
      const first = lines.findIndex((l) => /✖ failing tests:|⎯.*Failed (?:Suites|Tests) \d+/.test(l));
      const shown = first < 0 ? stdout.split("\n").slice(-80).join("\n") + stderr
        : [...lines.slice(first, first + 200), ...lines.length > first + 200 ? [`… ${lines.length - first - 200} more lines`] : []].join("\n");
      return [ok, "tests", ok ? "pass" : "fail", indent((shown + (t.stopped ? `\n${t.stopped}` : "")).trim()), `${manager.name} run test`];
    };
    said.push(await (fingerprint === undefined ? runTests() : remember(fingerprint, runTests, ([ok]) => ok)));
  } catch (e) {
    if (e instanceof InstallationChanged) throw e;
    said.push([false, "tests", (e as Error).message]);
  }
  return said;
}

/** Set a package up to run test/ with Vitest, as `spec init` does, and say what was added. */
function addVitest(root: string): string {
  const json = manifest(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ ...json, scripts: { ...json.scripts, test: "vitest run" } }, null, 2) + "\n");
  const config = !fs.readdirSync(root).some((f) => /^vitest\.config\.[cm]?[jt]s$/.test(f));
  if (config) fs.writeFileSync(path.join(root, "vitest.config.ts"), VITEST_CONFIG);
  return `test/ had nothing to run it: added "test": "vitest run" to package.json${config ? ", and vitest.config.ts" : ""}, as \`spec init\` does`;
}

/** What a module import reaches: generated code, a test library, or anything else (the shell, a service, a helper). */
const reaches = (quoted: string) => {
  const module = quoted.replace(/^["'`]|["'`]$/g, "");
  return /(?:^|\/)gen\//.test(module) ? "gen" : /^(?:vitest|@vitest\/.+|@effect\/vitest|effect(?:\/.+)?|node:test|node:assert(?:\/strict)?|assert|@testing-library\/.+)$/.test(module) ? "library" : "outside";
};

/**
 * The tests of one file, each as its line, whether it reaches only generated code and whether a citation covers it;
 * `generated` when the file imports nothing but gen/ and test libraries. A test is a call of `it` or `test` and what
 * it calls in the same file; it is covered by a citation in it, on the `describe` or layer around it, or in the
 * file's header. Nothing, if the file cannot be read as tokens.
 */
function readTests(text: string): { generated: boolean; tests: { line: number; generatedOnly: boolean; cited: boolean }[] } | undefined {
  const tokens = tokenize(text);
  if (!tokens) return undefined;
  const word = (i: number) => /^[A-Za-z_$][\w$]*$/.test(tokens[i]?.text ?? "");
  const closing = new Int32Array(tokens.length).fill(-1);
  const openAt: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    while (openAt.length && tokens[openAt.at(-1)!].depth >= tokens[i].depth) closing[openAt.pop()!] = i;
    openAt.push(i);
  }
  const close = (i: number) => closing[i];
  const lineStarts = [0];
  for (let p = text.indexOf("\n"); p !== -1; p = text.indexOf("\n", p + 1)) lineStarts.push(p + 1);
  const lineOf = (pos: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  // Top-level statements: a word that starts a line outside every bracket, unless the line before ends in an operator.
  const starts = tokens.flatMap((t, i) => t.depth === 0 && (i === 0 || t.fresh && word(i) && !/[=,.:?+\-*/%&|^<>!~]$/.test(tokens[i - 1].text)) ? [i] : []);
  const statements = starts.map((from, n) => ({ from, to: (starts[n + 1] ?? tokens.length) - 1 }));
  const bound = new Map<string, ReturnType<typeof reaches>>();
  const runners = new Set(["it", "test"]);
  const runnerNamespaces = new Set<string>();
  const helpers = new Map<string, { from: number; to: number }>();
  let header = text.length;
  for (const s of statements) {
    let i = s.from;
    if (tokens[i].text === "import" && tokens[i + 1]?.text !== "(") {
      if (tokens[i + 1].text === "type") continue;
      let fromAt = -1;
      for (let j = i + 1; j <= s.to; j++) if (tokens[j].text === "from") { fromAt = j; break; }
      const module = tokens[fromAt < 0 ? i + 1 : fromAt + 1].text;
      if (/^["'](?:vitest|@effect\/vitest|node:test)["']$/.test(module)) {
        if (tokens[i + 1]?.text === "*" && tokens[i + 2]?.text === "as") runnerNamespaces.add(tokens[i + 3].text);
        else if (word(i + 1)) runners.add(tokens[i + 1].text);
        for (let j = i + 1; j < fromAt; j++) if (["it", "test"].includes(tokens[j].text) && tokens[j - 1]?.text !== "type")
          runners.add(tokens[j + 1]?.text === "as" ? tokens[j + 2].text : tokens[j].text);
      }
      for (let j = i + 1; j < (fromAt < 0 ? i : fromAt); j++)
        if (word(j) && !["type", "as"].includes(tokens[j].text) && tokens[j - 1].text !== "type" && tokens[j + 1]?.text !== "as") bound.set(tokens[j].text, reaches(module));
      if (fromAt < 0) bound.set(`import ${module}`, reaches(module));
      continue;
    }
    header = Math.min(header, tokens[s.from].pos);
    while (["export", "default", "declare", "async", "effect"].includes(tokens[i].text)) i++;
    const declares = ["function", "class"].includes(tokens[i].text) ? [tokens[i + 1].text === "*" ? i + 2 : i + 1]
      : !["const", "let", "var"].includes(tokens[i].text) ? [] : word(i + 1) ? [i + 1]
      : ["{", "["].includes(tokens[i + 1]?.text) ? Array.from({ length: close(i + 1) - i - 2 }, (_, k) => i + 2 + k).filter(word) : [];
    for (const d of declares) helpers.set(tokens[d].text, s);
  }
  const blocks: { from: number; to: number }[] = [];
  tokens.forEach((t, i) => {
    let j = i + 1;
    if ([".", "function"].includes(tokens[i - 1]?.text)) return;
    if (runnerNamespaces.has(t.text) && tokens[j]?.text === "." && ["it", "test"].includes(tokens[j + 1]?.text)) j += 2;
    else if (runnerNamespaces.has(t.text) && tokens[j]?.text === "[" && /^["'](?:it|test)["']$/.test(tokens[j + 1]?.text ?? "") && tokens[j + 2]?.text === "]") j += 3;
    else if (!runners.has(t.text)) return;
    while (tokens[j]?.text === "." && word(j + 1)) j += 2;
    if (tokens[j]?.text !== "(") return;
    let to = close(j);
    while (tokens[to + 1]?.text === "(") to = close(to + 1);
    blocks.push({ from: i, to });
  });
  const ranges = [...statements, ...blocks];
  /** Where the code of a statement or test that comes before the first test inside it ends. */
  const inner = (r: { from: number; to: number }) => {
    let end = r.to + 1;
    for (const b of blocks) if (b !== r && b.from >= r.from && b.to <= r.to && b.from < end) end = b.from;
    return end;
  };
  const textOf = (from: number, to: number) => text.slice(tokens[from].pos, to < tokens.length ? tokens[to].pos : text.length);
  const headerCited = HAS_CITATION.test(text.slice(0, header));
  const rangeCited = new Map<object, boolean>();
  const isRangeCited = (r: { from: number; to: number }) => {
    let hit = rangeCited.get(r);
    if (hit === undefined) rangeCited.set(r, hit = HAS_CITATION.test(textOf(r.from, inner(r))));
    return hit;
  };
  const outsideNamed = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      if (tokens[i].text === "import" && tokens[i + 1]?.text === "(" && reaches(tokens[i + 2]?.text ?? "") === "outside") return true;
    }
    return false;
  };
  const imported = [...bound.values()];
  return {
    generated: imported.includes("gen") && !imported.includes("outside") && !outsideNamed(0, tokens.length),
    tests: blocks.map((b) => {
      const around = ranges.filter((r) => r !== b && r.from <= b.from && b.to <= r.to);
      // The names the test reaches, through the helpers of the file it calls.
      const named = new Set<string>();
      const seen = new Set<object>();
      const visit = (from: number, to: number) => {
        if (outsideNamed(from, to)) named.add("import()");
        for (let i = from; i < to; i++) {
          const helper = word(i) && helpers.get(tokens[i].text);
          if (word(i)) named.add(tokens[i].text);
          if (helper && !seen.has(helper)) {
            seen.add(helper);
            visit(helper.from, helper.to + 1);
          }
        }
      };
      visit(b.from, b.to + 1);
      for (const r of around) visit(r.from, inner(r));
      const kinds = [...named].map((n) => n === "import()" ? "outside" : bound.get(n));
      return {
        line: lineOf(tokens[b.from].start),
        generatedOnly: kinds.includes("gen") && !kinds.includes("outside"),
        cited: headerCited || HAS_CITATION.test(textOf(b.from, b.to + 1)) || around.some(isRangeCited),
      };
    }),
  };
}

/**
 * The rules a package's tests are held to (AGENTS.md, "Tests"): each reaches past generated code, which the spec
 * proves, and cites what it serves. Beside them, notes: test files to consolidate, and specs of this package that
 * its src/ may shell but that no test or driver checks.
 */
function testRules(checking: string, dir: string, specs: Spec[], testEntries: readonly (readonly [string, string])[], dirCitations: readonly Citation[]): Reported<"tests">[] {
  const root = path.join(checking, dir);
  const generatedOnly: string[] = [];
  const uncited: string[] = [];
  const said: Reported<"tests">[] = [];
  for (const [file, text] of testEntries) {
    const read = readTests(text);
    if (read?.generated) generatedOnly.push(`${dir}${file}: imports nothing but gen/ and test libraries`);
    for (const t of read?.tests ?? []) {
      if (t.generatedOnly && !read!.generated) generatedOnly.push(`${dir}${file}:${t.line}`);
      if (!t.cited) uncited.push(`${dir}${file}:${t.line}`);
    }
    const lines = text.split("\n").length;
    if (lines >= 15_000) said.push([true, "tests", `note: ${dir}${file} has ${lines} lines; at 15,000, consolidate and simplify it`]);
  }
  if (generatedOnly.length) said.push([false, "tests", `${generatedOnly.length} tests touch only generated code, which the spec proves: route each through src/, or propose deleting it`, indent(generatedOnly.join("\n"))]);
  if (uncited.length) said.push([false, "tests", `${uncited.length} tests cite no story or rule: cite the one each serves, fold it into the journey that does, or propose deleting it`, indent(uncited.join("\n"))]);
  // One file per package and runner is the norm: a browser test is another runner, a .vibe test another language.
  const groups = new Map<string, string[]>();
  for (const [f] of testEntries) {
    const key = `${/\.browser\.test\./.test(f)} ${/\.vibex?$/.test(f)}`;
    groups.set(key, [...groups.get(key) ?? [], dir + f]);
  }
  for (const group of groups.values()) if (group.length > 1) said.push([true, "tests", `note: ${group.join(", ")} run in one runner, in one language; one test file each is the norm, so consolidate them`]);
  if (fs.existsSync(path.join(root, "src"))) {
    const checked = new Set(dirCitations.filter((c) => c.at.startsWith(`${dir}test/`)).map((c) => c.spec));
    const owned = new Map<string, boolean>();
    const belongs = (file: string) => {
      const area = file.match(/^spec\/[^/]*\//)?.[0] ?? "";
      if (!owned.has(area)) owned.set(area, (owner(checking, file) ?? "") === dir.slice(0, -1));
      return owned.get(area);
    };
    // A companion's tests and drivers check its owner's specs as the owner's own do (util.ts, `specCompanionPaths`).
    const byCompanions = new Map<string, Set<string>>();
    const checkedBesides = (file: string) => {
      const area = file.match(/^spec\/[^/]*\//)?.[0] ?? "";
      if (!byCompanions.has(area)) {
        const others = companions(checking, file).map((other) => `${other}/`);
        byCompanions.set(area, new Set(citations(checking, others).filter((c) => others.some((other) => c.at.startsWith(`${other}test/`))).map((c) => c.spec)));
      }
      return byCompanions.get(area)!;
    };
    const driven = (s: Spec) => [dir, ...companions(checking, s.file).map((other) => `${other}/`)].some((at) => fs.existsSync(path.join(checking, at, "test/drivers", `${s.name}.ts`))
      || fs.existsSync(path.join(checking, at, "test/traces", `${s.name}.jsonl`)) || `driver:${s.name}` in packageScripts(path.join(checking, at)));
    const unchecked = specs.filter((s) => s.stories.length && !isStd(s.file) && belongs(s.file) && !checked.has(s.file) && !checkedBesides(s.file).has(s.file)
      && !driven(s));
    if (unchecked.length) said.push([true, "tests", `note: no test or driver checks ${unchecked.map((s) => s.file).join(", ")}; a story that leaves the verified core needs a journey that cites it`]);
  }
  return said;
}

/** Each place a `test/drivers/` module of the package `root` imports or re-exports `gen/` as a value, as `file:line: module`. */
function driverImports(root: string, entries: readonly (readonly [string, string])[]): string[] {
  if (!entries.length) return [];
  const ts = tsApi();
  const config = ts.findConfigFile(root, ts.sys.fileExists);
  const options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    ...config ? ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} })?.options : {} };
  const cache = ts.createModuleResolutionCache(root, (file) => file, options);
  return entries.flatMap(([file, text]) => {
    const source = ts.createSourceFile(path.resolve(root, file), text, ts.ScriptTarget.Latest, true);
    const host = ts.createCompilerHost({ noResolve: true, noLib: true });
    host.getSourceFile = (name) => name === source.fileName ? source : undefined;
    const checker = ts.createProgram([source.fileName], { noResolve: true, noLib: true }, host).getTypeChecker();
    const moduleName = (node: TS.Node | undefined, seen = new Set<TS.Symbol>()): string | undefined => {
      if (!node) return undefined;
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return moduleName(node.expression, seen);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = moduleName(node.left, seen), right = moduleName(node.right, seen);
        return left === undefined || right === undefined ? undefined : left + right;
      }
      if (ts.isTemplateExpression(node)) {
        let out = node.head.text;
        for (const span of node.templateSpans) { const value = moduleName(span.expression, seen); if (value === undefined) return undefined; out += value + span.literal.text; }
        return out;
      }
      const symbol = ts.isIdentifier(node) ? checker.getSymbolAtLocation(node) : undefined;
      const declaration = symbol?.valueDeclaration;
      if (!symbol || seen.has(symbol) || !declaration || !ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined;
      return moduleName(declaration.initializer, new Set([...seen, symbol]));
    };
    const typesOnly = (node: TS.ImportDeclaration | TS.ExportDeclaration) => ts.isImportDeclaration(node)
      ? !!node.importClause && (node.importClause.isTypeOnly || !node.importClause.name && !!node.importClause.namedBindings
        && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every((e) => e.isTypeOnly))
      : node.isTypeOnly || !!node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every((e) => e.isTypeOnly);
    const found: string[] = [];
    const visit = (node: TS.Node) => {
      const module = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && !typesOnly(node) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
      const name = moduleName(module);
      const resolved = name && ts.resolveModuleName(name, source.fileName, options, ts.sys, cache, undefined, ts.ModuleKind.ESNext).resolvedModule?.resolvedFileName;
      if (name !== undefined && /(?:^|\/)gen\//.test((resolved ?? name).split(path.sep).join("/")))
        found.push(`${file.split(path.sep).join("/")}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${name}`);
      node.forEachChild(visit);
    };
    visit(source);
    return found;
  });
}
