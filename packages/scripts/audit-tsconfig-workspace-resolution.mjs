#!/usr/bin/env node
/**
 * Audits workspace imports against the TypeScript projects that Turbo actually
 * typechecks. Resolution through generated declarations is accepted only when
 * the target workspace build precedes that typecheck, so stale local output
 * cannot hide a missing source alias.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import { resolveWorkspacePackageDirs } from "./lib/workspace-package-dirs.mjs";

const defaultRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function readJson(filePath, readFile = readFileSync) {
  return JSON.parse(readFile(filePath, "utf8"));
}

function splitShellStatements(script) {
  const statements = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    if (quote) {
      current += character;
      if (character === quote && script[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    const pair = script.slice(index, index + 2);
    if (pair === "&&" || pair === "||") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    if (character === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function tokenizeShellStatement(statement) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < statement.length; index += 1) {
    const character = statement[index];
    if (quote) {
      if (character === quote && statement[index - 1] !== "\\") quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function compilerTokenIndex(tokens) {
  return tokens.findIndex((token, index) => {
    const basename = path.basename(token);
    if (basename === "tsc" || basename === "tsc6") return true;
    return (
      (basename === "bunx" ||
        (basename === "bun" && tokens[index + 1] === "x")) &&
      /^(?:tsc|tsc6)$/.test(tokens[index + (basename === "bun" ? 2 : 1)] ?? "")
    );
  });
}

/** Derive every tsconfig consumed by direct compiler invocations in a script. */
export function discoverTypecheckProjects(packageDir, script) {
  const projects = [];
  for (const statement of splitShellStatements(script)) {
    const tokens = tokenizeShellStatement(statement);
    const compilerIndex = compilerTokenIndex(tokens);
    if (compilerIndex < 0) continue;
    let foundProject = false;
    for (let index = compilerIndex + 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === "-p" || token === "--project") {
        const project = tokens[index + 1];
        if (!project || project.startsWith("-")) {
          throw new Error(
            `typecheck compiler has ${token} without a project: ${statement}`,
          );
        }
        projects.push(path.resolve(packageDir, project));
        foundProject = true;
        index += 1;
      } else if (token.startsWith("--project=")) {
        projects.push(
          path.resolve(packageDir, token.slice("--project=".length)),
        );
        foundProject = true;
      } else if (token.startsWith("-p") && token.length > 2) {
        projects.push(path.resolve(packageDir, token.slice(2)));
        foundProject = true;
      }
    }
    if (!foundProject) projects.push(path.join(packageDir, "tsconfig.json"));
  }
  return [...new Set(projects)];
}

function dependencyNames(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
}

function taskDependencies(turbo, taskName) {
  return (
    turbo.tasks?.[taskName]?.dependsOn ??
    turbo.tasks?.[taskName.split("#").at(-1)]?.dependsOn ??
    []
  );
}

function buildClosure(packageName, manifestsByName, turbo, output = new Set()) {
  if (output.has(packageName)) return output;
  output.add(packageName);
  const manifest = manifestsByName.get(packageName);
  if (!manifest) return output;
  const dependencies = taskDependencies(turbo, `${packageName}#build`);
  for (const dependency of dependencies) {
    if (dependency === "^build") {
      for (const name of dependencyNames(manifest)) {
        if (manifestsByName.has(name))
          buildClosure(name, manifestsByName, turbo, output);
      }
    } else if (dependency.endsWith("#build")) {
      buildClosure(
        dependency.slice(0, -"#build".length),
        manifestsByName,
        turbo,
        output,
      );
    }
  }
  return output;
}

/** Model the workspace declaration outputs available before one Turbo typecheck. */
export function builtBeforeTypecheck(packageName, manifestsByName, turbo) {
  const built = new Set();
  const manifest = manifestsByName.get(packageName);
  for (const dependency of taskDependencies(
    turbo,
    `${packageName}#typecheck`,
  )) {
    if (dependency === "^build") {
      for (const name of dependencyNames(manifest ?? {})) {
        if (manifestsByName.has(name))
          buildClosure(name, manifestsByName, turbo, built);
      }
    } else if (dependency.endsWith("#build")) {
      buildClosure(
        dependency.slice(0, -"#build".length),
        manifestsByName,
        turbo,
        built,
      );
    }
  }
  return built;
}

function workspacePackageName(specifier, names) {
  let best = null;
  for (const name of names) {
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      if (!best || name.length > best.length) best = name;
    }
  }
  return best;
}

function pathPatternMatches(pattern, specifier) {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier;
  return (
    specifier.startsWith(pattern.slice(0, star)) &&
    specifier.endsWith(pattern.slice(star + 1))
  );
}

function declarationEntryIsGenerated(manifest, specifier, packageName) {
  const subpath =
    specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
  const candidates =
    specifier === packageName ? [manifest.types, manifest.typings] : [];
  const exports = manifest.exports;
  const matchingExport =
    typeof exports === "object" && exports
      ? (exports[subpath] ??
        Object.entries(exports).find(([pattern]) =>
          pathPatternMatches(pattern, subpath),
        )?.[1])
      : null;
  if (typeof matchingExport === "string") candidates.push(matchingExport);
  else if (typeof matchingExport === "object" && matchingExport) {
    candidates.push(matchingExport.types);
  }
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" && /(?:^|\/)dist(?:\/|$)/.test(candidate),
  );
}

function workspaceSourceEntry(manifest, specifier, packageName, packageDir) {
  const subpath =
    specifier === packageName ? "." : `.${specifier.slice(packageName.length)}`;
  const exports = manifest.exports;
  if (!exports || typeof exports !== "object") return null;
  let pattern = subpath;
  let entry = exports[subpath];
  if (entry === undefined) {
    const match = Object.entries(exports).find(([candidate]) =>
      pathPatternMatches(candidate, subpath),
    );
    if (!match) return null;
    [pattern, entry] = match;
  }
  let candidate =
    typeof entry === "string"
      ? entry
      : typeof entry === "object" && entry
        ? entry.types
        : null;
  if (typeof candidate !== "string" || /(?:^|\/)dist(?:\/|$)/.test(candidate)) {
    return null;
  }
  const star = pattern.indexOf("*");
  if (star >= 0) {
    const captured = subpath.slice(
      star,
      subpath.length - (pattern.length - star - 1),
    );
    candidate = candidate.replace("*", captured);
  }
  const resolved = path.resolve(packageDir, candidate);
  return existsSync(resolved) ? resolved : null;
}

function collectModuleSpecifiers(sourceFile) {
  const found = new Set();
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      found.add(node.moduleSpecifier.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      found.add(node.argument.literal.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      found.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function collectAmbientWorkspaceModules(sourceFile) {
  if (!sourceFile.isDeclarationFile || ts.isExternalModule(sourceFile)) {
    return [];
  }
  const found = [];
  const visit = (node) => {
    if (
      ts.isModuleDeclaration(node) &&
      ts.isStringLiteral(node.name) &&
      node.name.text.startsWith("@elizaos/")
    ) {
      found.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function configHost(readFile, overrides) {
  return {
    ...ts.sys,
    readFile(filePath) {
      const normalized = path.resolve(filePath);
      if (overrides.has(normalized)) return overrides.get(normalized);
      return readFile(filePath, "utf8");
    },
  };
}

function formatDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function inspectProject({
  repoRoot,
  configPath,
  packageName,
  manifestsByName,
  packageDirsByName,
  builtPackages,
  readFile,
  configOverrides,
  sourceFileCache,
  rootPathPatterns,
}) {
  const violations = [];
  if (
    !existsSync(configPath) &&
    !configOverrides.has(path.resolve(configPath))
  ) {
    return [`${packageName} typecheck -> ${configPath}: config does not exist`];
  }
  const host = configHost(readFile, configOverrides);
  const config = ts.readConfigFile(configPath, host.readFile);
  if (config.error) {
    return [
      `${packageName} typecheck -> ${configPath}: ${formatDiagnostic(config.error)}`,
    ];
  }
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    host,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    return parsed.errors.map(
      (error) =>
        `${packageName} typecheck -> ${configPath}: ${formatDiagnostic(error)}`,
    );
  }
  const moduleHost = ts.createCompilerHost(parsed.options);
  const reportedSpecifiers = new Set();
  const moduleResolutionCache = ts.createModuleResolutionCache(
    path.dirname(configPath),
    moduleHost.getCanonicalFileName,
    parsed.options,
  );
  const queue = [...parsed.fileNames];
  const visited = new Set();
  const ambientWorkspaceModules = new Map();
  const externallyImportedWorkspaceModules = new Map();
  const ownerDir = packageDirsByName.get(packageName);
  while (queue.length > 0) {
    const sourcePath = path.resolve(queue.shift());
    if (visited.has(sourcePath)) continue;
    visited.add(sourcePath);
    let sourceAnalysis = sourceFileCache.get(sourcePath);
    if (!sourceAnalysis) {
      const source = host.readFile(sourcePath);
      if (source === undefined) continue;
      const sourceFile = ts.createSourceFile(
        sourcePath,
        source,
        parsed.options.target ?? ts.ScriptTarget.Latest,
        false,
        ts.getScriptKindFromFileName(sourcePath),
      );
      sourceAnalysis = {
        ambientWorkspaceModules: collectAmbientWorkspaceModules(sourceFile),
        specifiers: collectModuleSpecifiers(sourceFile),
      };
      sourceFileCache.set(sourcePath, sourceAnalysis);
    }
    for (const specifier of sourceAnalysis.ambientWorkspaceModules) {
      if (
        Object.keys(parsed.options.paths ?? {}).some((pattern) =>
          pathPatternMatches(pattern, specifier),
        )
      ) {
        ambientWorkspaceModules.set(specifier, sourcePath);
      }
    }
    for (const specifier of sourceAnalysis.specifiers) {
      if (
        specifier.startsWith("@elizaos/") &&
        ownerDir &&
        !sourcePath.startsWith(`${ownerDir}${path.sep}`)
      ) {
        const importers =
          externallyImportedWorkspaceModules.get(specifier) ?? [];
        importers.push(sourcePath);
        externallyImportedWorkspaceModules.set(specifier, importers);
      }
      let resolution = ts.resolveModuleName(
        specifier,
        sourcePath,
        parsed.options,
        moduleHost,
        moduleResolutionCache,
      ).resolvedModule;
      const targetName = specifier.startsWith("@elizaos/")
        ? workspacePackageName(specifier, manifestsByName.keys())
        : null;
      if (!resolution && targetName) {
        const sourceEntry = workspaceSourceEntry(
          manifestsByName.get(targetName),
          specifier,
          targetName,
          packageDirsByName.get(targetName),
        );
        if (sourceEntry) {
          resolution = {
            resolvedFileName: sourceEntry,
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
          };
        }
      }
      if (
        resolution &&
        !resolution.isExternalLibraryImport &&
        !resolution.resolvedFileName.includes("node_modules") &&
        !resolution.resolvedFileName.includes(`${path.sep}dist${path.sep}`) &&
        !resolution.resolvedFileName.endsWith(".d.ts")
      ) {
        queue.push(resolution.resolvedFileName);
      }
      if (!specifier.startsWith("@elizaos/")) continue;
      if (
        !Object.keys(parsed.options.paths ?? {}).some((pattern) =>
          pattern.startsWith("@elizaos/"),
        ) ||
        !rootPathPatterns.some((pattern) =>
          pathPatternMatches(pattern, specifier),
        )
      ) {
        continue;
      }
      let valid = Boolean(resolution);
      if (targetName) {
        if (targetName === packageName) valid = true;
        else {
          const target = manifestsByName.get(targetName);
          if (declarationEntryIsGenerated(target, specifier, targetName)) {
            const resolvedToGeneratedOutput =
              resolution?.resolvedFileName.includes(
                `${path.sep}dist${path.sep}`,
              ) ?? false;
            valid =
              (Boolean(resolution) && !resolvedToGeneratedOutput) ||
              builtPackages.has(targetName);
          } else {
            // Source entries must resolve independently of generated output.
            valid = Boolean(resolution);
          }
        }
      }
      if (!valid && !reportedSpecifiers.has(specifier)) {
        reportedSpecifiers.add(specifier);
        violations.push(
          `${packageName} typecheck -> ${path.relative(repoRoot, configPath)}: unresolved ${specifier} imported by ${path.relative(repoRoot, sourcePath)}`,
        );
      }
    }
  }
  const semanticCandidates = new Map(
    [...ambientWorkspaceModules].filter(([specifier]) =>
      externallyImportedWorkspaceModules.has(specifier),
    ),
  );
  if (semanticCandidates.size > 0) {
    const semanticRoots = [
      ...semanticCandidates.values(),
      ...[...semanticCandidates.keys()].flatMap(
        (specifier) => externallyImportedWorkspaceModules.get(specifier) ?? [],
      ),
    ];
    const program = ts.createProgram({
      rootNames: [...new Set(semanticRoots)],
      options: parsed.options,
      host: moduleHost,
    });
    for (const diagnostic of program.getSemanticDiagnostics()) {
      if (diagnostic.code !== 2305 || !diagnostic.file) continue;
      const message = formatDiagnostic(diagnostic);
      const specifier = message.match(/@elizaos\/[\w./-]+/)?.[0];
      const declarationPath = specifier
        ? semanticCandidates.get(specifier)
        : null;
      if (!specifier || !declarationPath) continue;
      violations.push(
        `${packageName} typecheck -> ${path.relative(repoRoot, configPath)}: ambient ${specifier} in ${path.relative(repoRoot, declarationPath)} hides source exports required by ${path.relative(repoRoot, diagnostic.file.fileName)}`,
      );
    }
  }
  return violations;
}

/** Audit every direct TypeScript typecheck project in the workspace graph. */
export function auditTsconfigWorkspaceResolution(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const readFile = options.readFile ?? readFileSync;
  const rootManifest =
    options.rootManifest ??
    readJson(path.join(repoRoot, "package.json"), readFile);
  const turbo =
    options.turbo ?? readJson(path.join(repoRoot, "turbo.json"), readFile);
  const rootTsconfig = readJson(path.join(repoRoot, "tsconfig.json"), readFile);
  const rootPathPatterns = Object.keys(
    rootTsconfig.compilerOptions?.paths ?? {},
  );
  const packageDirs =
    options.packageDirs ??
    resolveWorkspacePackageDirs(repoRoot, rootManifest.workspaces);
  const configOverrides = new Map(
    [...(options.configOverrides ?? new Map())].map(([filePath, contents]) => [
      path.resolve(filePath),
      contents,
    ]),
  );
  const manifestsByName = new Map();
  const packageDirsByName = new Map();
  for (const packageDir of packageDirs) {
    const manifest = readJson(path.join(packageDir, "package.json"), readFile);
    if (!manifest.name) continue;
    manifestsByName.set(manifest.name, manifest);
    packageDirsByName.set(manifest.name, packageDir);
  }
  const violations = [];
  let projects = 0;
  const sourceFileCache = new Map();
  const selectedPackageNames = options.selectedPackageNames
    ? new Set(options.selectedPackageNames)
    : null;
  for (const [packageName, manifest] of manifestsByName) {
    if (selectedPackageNames && !selectedPackageNames.has(packageName))
      continue;
    const script = manifest.scripts?.typecheck;
    if (!script || /^\s*echo\b/i.test(script)) continue;
    let projectPaths;
    try {
      projectPaths = discoverTypecheckProjects(
        packageDirsByName.get(packageName),
        script,
      );
    } catch (error) {
      violations.push(`${packageName} typecheck: ${error.message}`);
      continue;
    }
    if (projectPaths.length === 0) {
      violations.push(
        `${packageName} typecheck: no direct TypeScript project discovered in ${script}`,
      );
      continue;
    }
    const builtPackages = builtBeforeTypecheck(
      packageName,
      manifestsByName,
      turbo,
    );
    for (const configPath of projectPaths) {
      projects += 1;
      violations.push(
        ...inspectProject({
          repoRoot,
          configPath,
          packageName,
          manifestsByName,
          packageDirsByName,
          builtPackages,
          readFile,
          configOverrides,
          sourceFileCache,
          rootPathPatterns,
        }),
      );
    }
  }
  return { projects, violations: [...new Set(violations)].sort() };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = auditTsconfigWorkspaceResolution();
  console.log(
    `[audit-tsconfig-workspace-resolution] inspected ${result.projects} project(s)`,
  );
  if (result.violations.length > 0) {
    console.error(
      `[audit-tsconfig-workspace-resolution] ${result.violations.length} violation(s):\n${result.violations.map((violation) => `- ${violation}`).join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      "[audit-tsconfig-workspace-resolution] ✓ workspace imports resolve in their typecheck projects",
    );
  }
}
