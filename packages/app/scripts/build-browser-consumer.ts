/**
 * Produce the browser application API with the canonical renderer resolver and
 * chunk pipeline. The consuming shell supplies the single React/Capacitor instance.
 * No source projections, host stubs or alternate application client are generated.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  build,
  defaultClientConditions,
  esmExternalRequirePlugin,
  loadConfigFromFile,
  mergeConfig,
} from "vite";

const repository = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const app = path.join(repository, "packages/app");
const entry = path.join(
  repository,
  "packages/app/src/renderer/browser-consumer.tsx",
);
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" }).trim();
const peer = /^(react|react-dom|@capacitor\/core)(\/.*)?$/;
const args = process.argv.slice(2);
const diagnostic = args.includes("--allow-dirty-diagnostic");
const outputAt = args.indexOf("--out-dir");
if (
  outputAt < 0 ||
  !args[outputAt + 1] ||
  args.some(
    (arg, index) =>
      arg !== "--allow-dirty-diagnostic" &&
      arg !== "--out-dir" &&
      index !== outputAt + 1,
  )
)
  throw Error(
    "Usage: build-browser-consumer.ts --out-dir <empty-directory> [--allow-dirty-diagnostic]",
  );
const output = path.resolve(args[outputAt + 1]);
if (output === repository || repository.startsWith(`${output}${path.sep}`))
  throw Error("Unsafe output directory");
if (fs.existsSync(output) && fs.readdirSync(output).length)
  throw Error("Consumer output must be empty");
const revision = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain=v1", "--untracked-files=normal");
if (dirty && !diagnostic)
  throw Error(
    "A distributable consumer requires a clean reviewed source revision",
  );
const sourceDigest = hash(
  execFileSync("git", ["-C", repository, "diff", "HEAD", "--binary"]),
);
const lockDigest = hash(fs.readFileSync(path.join(repository, "bun.lock")));
fs.mkdirSync(output, { recursive: true });

const loaded = await loadConfigFromFile(
  { command: "build", mode: "production" },
  path.join(app, "vite.config.ts"),
  app,
);
if (!loaded) throw Error("Canonical renderer configuration is unavailable");
const inputs = new Map<string, string>();
for (const filename of [fileURLToPath(import.meta.url), entry])
  inputs.set(filename, hash(fs.readFileSync(filename)));
const config = mergeConfig(loaded.config, {
  plugins: [
    esmExternalRequirePlugin({ external: [peer] }),
    {
      name: "browser-consumer-source-receipt",
      transform(_code: string, id: string) {
        const filename = id.split("?")[0];
        if (
          filename &&
          path.isAbsolute(filename) &&
          fs.existsSync(filename) &&
          fs.statSync(filename).isFile()
        )
          inputs.set(filename, hash(fs.readFileSync(filename)));
        return null;
      },
    },
  ],
  // A fresh checkout has no built workspace dist. Source-mode diagnostics use
  // the canonical development resolver without changing distributable builds.
  ...(diagnostic
    ? { resolve: { conditions: ["eliza-source", ...defaultClientConditions] } }
    : {}),
  configFile: false,
  root: app,
  base: "./",
  publicDir: false,
  build: {
    outDir: output,
    emptyOutDir: false,
    copyPublicDir: false,
    cssCodeSplit: false,
    lib: {
      entry,
      formats: ["es"],
      fileName: () => "index.js",
      cssFileName: "consumer",
    },
    rollupOptions: {
      input: entry,
      preserveEntrySignatures: "strict",
      output: {
        entryFileNames: "index.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
    rolldownOptions: {
      input: entry,
      preserveEntrySignatures: "strict",
      output: {
        entryFileNames: "index.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
// mergeConfig merges object inputs; the library has exactly one public entry.
if (config.build?.rollupOptions) config.build.rollupOptions.input = entry;
if (config.build?.rolldownOptions) config.build.rolldownOptions.input = entry;
await build(config);

const runtimeSourceFiles = Object.fromEntries(
  [...inputs]
    .filter(
      ([filename]) =>
        /\.[cm]?[jt]sx?$/.test(filename) && !/\.d\.[cm]?ts$/.test(filename),
    )
    .map(([filename, sha256]) => [
      path.relative(repository, filename).split(path.sep).join("/"),
      sha256,
    ]),
);
// This entry imports UI source directly. A compiled UI copy creates separate
// contexts and transport state even when React itself is a shared peer.
const compiledUiRuntime = Object.keys(runtimeSourceFiles).filter((filename) =>
  filename.startsWith("packages/ui/dist/"),
);
if (compiledUiRuntime.length)
  throw Error(
    `Consumer runtime mixes UI source with compiled UI modules: ${compiledUiRuntime.join(", ")}`,
  );

// The application has root-relative icons and other static resources. Preserve
// their canonical layout for the consuming host to stage at its web root.
const staticAssets: string[] = [];
function copyPublic(directory: string, relative = "") {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = relative ? `${relative}/${item.name}` : item.name;
    const source = path.join(directory, item.name);
    if (item.isSymbolicLink())
      throw Error("Canonical public asset is a symlink");
    if (item.isDirectory()) copyPublic(source, name);
    else if (item.isFile()) {
      const target = path.join(output, "public", name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      inputs.set(source, hash(fs.readFileSync(source)));
      staticAssets.push(name);
    }
  }
}
copyPublic(path.join(app, "public"));

// Emit genuine declarations from the same public source and dependency closure.
// Workspace imports are redirected to their emitted declaration files. External
// declaration packages remain explicit dependencies in the artifact manifest.
const typeRoot = path.join(output, "types");
const cfg = ts.readConfigFile(
  path.join(repository, "packages/ui/tsconfig.json"),
  ts.sys.readFile,
);
if (cfg.error)
  throw Error(ts.flattenDiagnosticMessageText(cfg.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(
  cfg.config,
  ts.sys,
  path.join(repository, "packages/ui"),
);
const options: ts.CompilerOptions = {
  ...parsed.options,
  declaration: true,
  declarationMap: false,
  emitDeclarationOnly: true,
  noEmit: false,
  incremental: false,
  composite: false,
  rootDir: repository,
  outDir: typeRoot,
  rewriteRelativeImportExtensions: true,
};
const ambient = parsed.fileNames.filter((name) => name.endsWith(".d.ts"));
let program = ts.createProgram([entry, ...ambient], options);
const emitted = new Map<string, string>();
const runtimeTypePath = (filename: string) =>
  filename
    .replace(/\.d\.mts$/, ".mjs")
    .replace(/\.d\.cts$/, ".cjs")
    .replace(/\.d\.ts$/, ".js");
const errors = [
  ...program.getOptionsDiagnostics(),
  ...program.getGlobalDiagnostics(),
  ...program.getSyntacticDiagnostics(),
  ...program.getSemanticDiagnostics(),
].filter((item) => item.category === ts.DiagnosticCategory.Error);
const failDiagnostics = (diagnostics: readonly ts.Diagnostic[]) => {
  if (diagnostics.length)
    throw Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => repository,
        getNewLine: () => "\n",
      }),
    );
};
failDiagnostics(errors);
// Source exports resolved through workspace package names are still classified
// as external libraries by TypeScript. Explicitly root those same checked
// source files so the declaration emitter can include their public types.
const workspaceRoots = program.getSourceFiles().flatMap((source) => {
  const filename = fs.realpathSync(source.fileName);
  return !source.isDeclarationFile &&
    filename.startsWith(`${repository}${path.sep}`) &&
    !filename.includes(`${path.sep}node_modules${path.sep}`)
    ? [filename]
    : [];
});
program = ts.createProgram({
  rootNames: [...workspaceRoots, ...ambient],
  options,
  oldProgram: program,
});
// Check the whole runtime graph above, but emit only the public declaration
// graph. Private inferred exports are not part of the consumer's API.
const sourceByRealPath = new Map(
  program
    .getSourceFiles()
    .map((source) => [fs.realpathSync(source.fileName), source]),
);
const queue: ts.SourceFile[] = [];
function emitPublic(source: ts.SourceFile) {
  const filename = fs.realpathSync(source.fileName);
  if (emitted.has(filename)) return;
  if (source.isDeclarationFile || filename.endsWith(".json")) {
    const target = path.join(typeRoot, path.relative(repository, filename));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(filename, target);
    emitted.set(filename, target);
  } else {
    const result = program.emit(source, (name, text, _bom, _error, sources) => {
      fs.mkdirSync(path.dirname(name), { recursive: true });
      fs.writeFileSync(name, text);
      if (sources?.length === 1)
        emitted.set(fs.realpathSync(sources[0].fileName), name);
    });
    failDiagnostics(result.diagnostics);
    if (!emitted.has(filename))
      throw Error(`No public declaration emitted: ${filename}`);
  }
  if (!filename.endsWith(".json")) queue.push(source);
}
const publicSource = program.getSourceFile(entry);
if (!publicSource)
  throw Error("Public entry is absent from the checked program");
emitPublic(publicSource);
const styleDeclarationSources = new Set<string>();
for (const source of program.getSourceFiles()) {
  const filename = fs.realpathSync(source.fileName);
  if (
    source.isDeclarationFile &&
    filename.startsWith(`${repository}${path.sep}`) &&
    !filename.includes(`${path.sep}node_modules${path.sep}`) &&
    source.statements.some(
      (statement) =>
        ts.isModuleDeclaration(statement) &&
        ts.isStringLiteral(statement.name) &&
        statement.name.text === "*.css",
    )
  ) {
    emitPublic(source);
    styleDeclarationSources.add(filename);
  }
}
const typeDependencies = new Map<
  string,
  {
    specifier: string;
    package: string;
    version: string;
    packageJsonSha256: string;
  }
>();
function moduleSpecifier(node: ts.Node): ts.StringLiteralLike | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  )
    return node.moduleSpecifier;
  if (
    ts.isImportTypeNode(node) &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  )
    return node.argument.literal;
  if (
    ts.isExternalModuleReference(node) &&
    node.expression &&
    ts.isStringLiteralLike(node.expression)
  )
    return node.expression;
  return undefined;
}
for (let i = 0; i < queue.length; i++) {
  const source = fs.realpathSync(queue[i].fileName);
  const declaration = emitted.get(source)!;
  const original = fs.readFileSync(declaration, "utf8");
  const parsedDeclaration = ts.createSourceFile(
    declaration,
    original,
    ts.ScriptTarget.Latest,
    true,
  );
  const replacements: { from: number; to: number; text: string }[] = [];
  const preservedReferences = queue[i].referencedFiles.filter(
    (reference) => reference.preserve,
  );
  if (preservedReferences.length !== parsedDeclaration.referencedFiles.length)
    throw Error(`Public reference directive mismatch: ${source}`);
  for (const [
    index,
    reference,
  ] of parsedDeclaration.referencedFiles.entries()) {
    const targetSource = fs.realpathSync(
      path.resolve(path.dirname(source), preservedReferences[index].fileName),
    );
    const target = sourceByRealPath.get(targetSource);
    if (!target)
      throw Error(`Missing public reference directive: ${targetSource}`);
    emitPublic(target);
    let relative = path
      .relative(path.dirname(declaration), emitted.get(targetSource)!)
      .split(path.sep)
      .join("/");
    if (!relative.startsWith(".")) relative = `./${relative}`;
    replacements.push({
      from: reference.pos,
      to: reference.end,
      text: relative,
    });
  }
  function visit(node: ts.Node) {
    const literal = moduleSpecifier(node);
    if (literal) {
      const specifier = literal.text;
      if (
        ts.isImportDeclaration(node) &&
        !node.importClause &&
        (specifier === "@elizaos/ui/styles" || specifier.endsWith(".css"))
      ) {
        // Vite owns these renderer effects in the single styles.js entry.
        // Public declarations must not require a CSS loader or wallet CSS types.
        replacements.push({
          from: node.getFullStart(),
          to: node.end,
          text: "",
        });
        return;
      }
      const resolved = ts.resolveModuleName(
        specifier,
        source,
        options,
        ts.sys,
      ).resolvedModule;
      const filename =
        resolved && fs.existsSync(resolved.resolvedFileName)
          ? fs.realpathSync(resolved.resolvedFileName)
          : undefined;
      if (
        filename?.startsWith(`${repository}${path.sep}`) &&
        !filename.includes(`${path.sep}node_modules${path.sep}`)
      ) {
        const dependency = sourceByRealPath.get(filename);
        if (!dependency)
          throw Error(`Public declaration dependency is absent: ${specifier}`);
        emitPublic(dependency);
        let relative = runtimeTypePath(
          path
            .relative(path.dirname(declaration), emitted.get(filename)!)
            .split(path.sep)
            .join("/"),
        );
        if (!relative.startsWith(".")) relative = `./${relative}`;
        replacements.push({
          from: literal.getStart(parsedDeclaration),
          to: literal.getEnd(),
          text: JSON.stringify(relative),
        });
      } else if (
        !specifier.startsWith(".") &&
        !specifier.startsWith("/") &&
        !specifier.startsWith("node:")
      ) {
        if (!filename)
          throw Error(`Unresolved public type dependency: ${specifier}`);
        let directory = path.dirname(filename),
          metadata: string | undefined;
        while (directory !== path.dirname(directory)) {
          const candidate = path.join(directory, "package.json");
          if (fs.existsSync(candidate)) {
            const identity = JSON.parse(fs.readFileSync(candidate, "utf8"));
            // Type subdirectories can contain a package.json with only
            // {type:"module"}; provenance belongs to the named package root.
            if (identity.name && identity.version) {
              metadata = candidate;
              break;
            }
          }
          directory = path.dirname(directory);
        }
        if (!metadata)
          throw Error(`Missing type package identity: ${specifier}`);
        const bytes = fs.readFileSync(metadata),
          identity = JSON.parse(bytes.toString());
        if (!identity.name || !identity.version)
          throw Error(`Unversioned type dependency: ${specifier}`);
        typeDependencies.set(specifier, {
          specifier,
          package: identity.name,
          version: identity.version,
          packageJsonSha256: hash(bytes),
        });
        inputs.set(metadata, hash(bytes));
      } else if (specifier.endsWith(".css") && specifier.startsWith(".")) {
        // Preserve the real type-only side-effect target; runtime CSS is the
        // single ordered Vite asset imported through styles.js below.
        const stylesheet = path.resolve(path.dirname(source), specifier);
        const target = path.resolve(path.dirname(declaration), specifier);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(stylesheet, target);
        inputs.set(stylesheet, hash(fs.readFileSync(stylesheet)));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsedDeclaration);
  let updated = original;
  for (const change of replacements.sort((a, b) => b.from - a.from))
    updated =
      updated.slice(0, change.from) + change.text + updated.slice(change.to);
  fs.writeFileSync(declaration, updated);
}
for (const source of program.getSourceFiles()) {
  if (path.isAbsolute(source.fileName) && fs.existsSync(source.fileName))
    inputs.set(source.fileName, hash(fs.readFileSync(source.fileName)));
}
const declarationEntry = emitted.get(fs.realpathSync(entry));
if (!declarationEntry) throw Error("Public declaration entry was not emitted");
const cssReferences = [...emitted]
  .filter(([filename]) => styleDeclarationSources.has(filename))
  .map(
    ([, target]) =>
      `/// <reference path="./${path.relative(output, target).split(path.sep).join("/")}" />\n`,
  )
  .join("");
fs.writeFileSync(
  path.join(output, "index.d.ts"),
  `${cssReferences}export * from "./${runtimeTypePath(path.relative(output, declarationEntry).split(path.sep).join("/"))}";\n`,
);
const stylesheetFiles = fs
  .readdirSync(output, { recursive: true })
  .filter(
    (name): name is string =>
      typeof name === "string" &&
      name.endsWith(".css") &&
      !name.startsWith("types/"),
  );
if (stylesheetFiles.length !== 1)
  throw Error("Canonical consumer must emit one ordered CSS asset");
fs.writeFileSync(
  path.join(output, "styles.js"),
  stylesheetFiles
    .map((name) => `import ${JSON.stringify(`./${name}`)};`)
    .join("\n") + "\n",
);
const files: Record<string, { sha256: string; bytes: number }> = {};
function inventory(directory: string) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name);
    if (item.isSymbolicLink())
      throw Error("Consumer output contains a symlink");
    if (item.isDirectory()) inventory(filename);
    else {
      const bytes = fs.readFileSync(filename);
      files[path.relative(output, filename).split(path.sep).join("/")] = {
        sha256: hash(bytes),
        bytes: bytes.length,
      };
    }
  }
}
inventory(output);
const runtimeImports = new Set<string>();
for (const filename of Object.keys(files).filter((name) =>
  name.endsWith(".js"),
)) {
  const script = ts.createSourceFile(
    filename,
    fs.readFileSync(path.join(output, filename), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  function inspect(node: ts.Node) {
    const literal =
      moduleSpecifier(node) ??
      (ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
        ? node.arguments[0]
        : undefined);
    if (
      literal &&
      ts.isStringLiteralLike(literal) &&
      !literal.text.startsWith(".") &&
      !literal.text.startsWith("/")
    ) {
      if (!peer.test(literal.text))
        throw Error(
          `Unbundled browser runtime import: ${filename}: ${literal.text}`,
        );
      runtimeImports.add(literal.text);
    }
    ts.forEachChild(node, inspect);
  }
  inspect(script);
}
for (const dependency of typeDependencies.values())
  if (dependency.package.startsWith("@elizaos/"))
    throw Error(`Unbundled workspace type dependency: ${dependency.specifier}`);
for (const [filename, expected] of inputs)
  if (hash(fs.readFileSync(filename)) !== expected)
    throw Error(`Consumer source changed during build: ${filename}`);
if (
  git("rev-parse", "HEAD") !== revision ||
  hash(execFileSync("git", ["-C", repository, "diff", "HEAD", "--binary"])) !==
    sourceDigest ||
  hash(fs.readFileSync(path.join(repository, "bun.lock"))) !== lockDigest
)
  throw Error("Source changed during consumer build");
fs.writeFileSync(
  path.join(output, "manifest.json"),
  `${JSON.stringify(
    {
      schema: "eliza-browser-consumer-v1",
      revision,
      distributable: !dirty && !diagnostic,
      diagnostic,
      sourceDiffSha256: sourceDigest,
      lockSha256: lockDigest,
      entry: "index.js",
      types: "index.d.ts",
      typeCompilerOptions: { resolveJsonModule: true },
      sharedPeers: ["react", "react-dom", "@capacitor/core"],
      runtimeImports: [...runtimeImports].sort(),
      typeDependencies: [...typeDependencies.values()].sort((a, b) =>
        a.specifier.localeCompare(b.specifier),
      ),
      stylesEntry: "styles.js",
      runtimeSourceFiles,
      staticAssets: staticAssets.sort(),
      styles: stylesheetFiles.sort(),
      sourceFiles: Object.fromEntries(
        [...inputs].map(([filename, sha256]) => [
          path.relative(repository, filename).split(path.sep).join("/"),
          sha256,
        ]),
      ),
      files,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Browser consumer ${diagnostic ? "diagnostic" : "distributable"}: ${output}`,
);
