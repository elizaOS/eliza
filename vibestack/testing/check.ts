import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import ts from "typescript";
import { InstallationChanged } from "../installed.ts";
import { isStd, type Spec } from "../parse.ts";
import { exec } from "../run.ts";
import { CITATION, citations, danglingCitations, indent, isTestFile, manifest, owner, packageCode, packageManager, packageScripts, testInputs, testReceipt, tokenize, type Remember, type Reported } from "../util.ts";
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
    const dangling = danglingCitations(checking, specs, dir);
    if (dangling.length) said.push([false, "tests", `${dangling.length} citations name no story or rule of the spec`, indent(dangling.join("\n"))]);
    const oracle = driverImports(root).map((problem) => dir + problem);
    if (oracle.length) said.push([false, "tests", "a driver imports gen/ as types only: it reaches the application, and the spec is the oracle the traces stage compares it with", indent(oracle.join("\n"))]);
    said.push(...testRules(checking, dir, specs));
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
  /** The bracket that closes the one at `i`: the next token as deep. */
  const close = (i: number) => tokens.findIndex((t, j) => j > i && t.depth === tokens[i].depth);
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
      const fromAt = tokens.findIndex((t, j) => j > i && j <= s.to && t.text === "from");
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
  const inner = (r: { from: number; to: number }) => Math.min(r.to + 1, ...blocks.filter((b) => b !== r && b.from >= r.from && b.to <= r.to).map((b) => b.from));
  const textOf = (from: number, to: number) => text.slice(tokens[from].pos, to < tokens.length ? tokens[to].pos : text.length);
  const cites = (s: string) => new RegExp(CITATION.source).test(s);
  const outsideNamed = (from: number, to: number) => tokens.slice(from, to).some((t, k) => t.text === "import" && tokens[from + k + 1]?.text === "(" && reaches(tokens[from + k + 2]?.text ?? "") === "outside");
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
        line: text.slice(0, tokens[b.from].start).split("\n").length,
        generatedOnly: kinds.includes("gen") && !kinds.includes("outside"),
        cited: cites(text.slice(0, header)) || cites(textOf(b.from, b.to + 1)) || around.some((r) => cites(textOf(r.from, inner(r)))),
      };
    }),
  };
}

/**
 * The rules a package's tests are held to (AGENTS.md, "Tests"): each reaches past generated code, which the spec
 * proves, and cites what it serves. Beside them, notes: test files to consolidate, and specs of this package that
 * its src/ may shell but that no test or driver checks.
 */
function testRules(checking: string, dir: string, specs: Spec[]): Reported<"tests">[] {
  const root = path.join(checking, dir);
  const files = packageCode(root).filter(isTestFile);
  const generatedOnly: string[] = [];
  const uncited: string[] = [];
  const said: Reported<"tests">[] = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
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
  for (const f of files) {
    const key = `${/\.browser\.test\./.test(f)} ${/\.vibex?$/.test(f)}`;
    groups.set(key, [...groups.get(key) ?? [], dir + f]);
  }
  for (const group of groups.values()) if (group.length > 1) said.push([true, "tests", `note: ${group.join(", ")} run in one runner, in one language; one test file each is the norm, so consolidate them`]);
  if (fs.existsSync(path.join(root, "src"))) {
    const scripts = packageScripts(root);
    const checked = new Set(citations(checking, [dir]).filter((c) => c.at.startsWith(`${dir}test/`)).map((c) => c.spec));
    const owned = new Map<string, boolean>();
    const belongs = (file: string) => {
      const area = file.match(/^spec\/[^/]*\//)?.[0] ?? "";
      if (!owned.has(area)) owned.set(area, (owner(checking, file) ?? "") === dir.slice(0, -1));
      return owned.get(area);
    };
    const unchecked = specs.filter((s) => s.stories.length && !isStd(s.file) && belongs(s.file) && !checked.has(s.file)
      && !fs.existsSync(path.join(root, "test/drivers", `${s.name}.ts`)) && !fs.existsSync(path.join(root, "test/traces", `${s.name}.jsonl`)) && !(`driver:${s.name}` in scripts));
    if (unchecked.length) said.push([true, "tests", `note: no test or driver checks ${unchecked.map((s) => s.file).join(", ")}; a story that leaves the verified core needs a journey that cites it`]);
  }
  return said;
}

/** Each place a `test/drivers/` module of the package `root` imports or re-exports `gen/` as a value, as `file:line: module`. */
function driverImports(root: string): string[] {
  const files = packageCode(root).filter((file) => file.startsWith("test/drivers/"));
  if (!files.length) return [];
  const config = ts.findConfigFile(root, ts.sys.fileExists);
  const options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    ...config ? ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} })?.options : {} };
  const cache = ts.createModuleResolutionCache(root, (file) => file, options);
  return files.flatMap((file) => {
    const source = ts.createSourceFile(path.resolve(root, file), fs.readFileSync(path.join(root, file), "utf8"), ts.ScriptTarget.Latest, true);
    const host = ts.createCompilerHost({ noResolve: true, noLib: true });
    host.getSourceFile = (file) => file === source.fileName ? source : undefined;
    const checker = ts.createProgram([source.fileName], { noResolve: true, noLib: true }, host).getTypeChecker();
    const moduleName = (node: ts.Node | undefined, seen = new Set<ts.Symbol>()): string | undefined => {
      if (!node) return undefined;
      if (ts.isStringLiteralLike(node)) return node.text;
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return moduleName(node.expression, seen);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = moduleName(node.left, seen), right = moduleName(node.right, seen);
        return left === undefined || right === undefined ? undefined : left + right;
      }
      if (ts.isTemplateExpression(node)) {
        let text = node.head.text;
        for (const span of node.templateSpans) { const value = moduleName(span.expression, seen); if (value === undefined) return undefined; text += value + span.literal.text; }
        return text;
      }
      const symbol = ts.isIdentifier(node) ? checker.getSymbolAtLocation(node) : undefined;
      const declaration = symbol?.valueDeclaration;
      if (!symbol || seen.has(symbol) || !declaration || !ts.isVariableDeclaration(declaration) || !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined;
      return moduleName(declaration.initializer, new Set([...seen, symbol]));
    };
    const typesOnly = (node: ts.ImportDeclaration | ts.ExportDeclaration) => ts.isImportDeclaration(node)
      ? !!node.importClause && (node.importClause.isTypeOnly || !node.importClause.name && !!node.importClause.namedBindings
        && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every((e) => e.isTypeOnly))
      : node.isTypeOnly || !!node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every((e) => e.isTypeOnly);
    const found: string[] = [];
    const visit = (node: ts.Node) => {
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
