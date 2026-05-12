#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(here, "../..");
const MARKDOWN_LINK_RE = /!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HTML_LINK_RE = /<(?:a|img)\b[^>]*(?:href|src)=["']([^"']+)["'][^>]*>/gi;
const BUN_RUN_RE =
  /(?:^|[;&|(`\s])(?:(?:cd\s+([^\s;&|`]+)\s*&&\s*)?bun\s+run(?:\s+--cwd\s+([^\s;&|`]+))?\s+([A-Za-z0-9:_-]+))(?=$|[\s`)&;|])/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;
const EXPLICIT_ANCHOR_RE =
  /<(?:a|[^>]+\s)\b(?:name|id)=["']([^"']+)["'][^>]*>/gi;
const SKIP_DIRS = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

function rel(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function exists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function walkMarkdownFiles(dir) {
  if (!exists(dir)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

function walkReadmes(dir) {
  if (!exists(dir)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkReadmes(fullPath));
    } else if (entry.isFile() && entry.name === "README.md") {
      files.push(fullPath);
    }
  }
  return files;
}

function walkPackageJsons(dir) {
  if (!exists(dir)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkPackageJsons(fullPath));
    } else if (entry.isFile() && entry.name === "package.json") {
      files.push(fullPath);
    }
  }
  return files;
}

function collectDocs(repoRoot, scope = "all") {
  const files = new Set();
  const dirs =
    scope === "launchdocs"
      ? [
          "packages/docs/docs/launchdocs",
          "packages/docs/launchdocs",
          "launchdocs",
        ]
      : scope === "docs"
        ? ["packages/docs/docs", "packages/docs", "docs"]
        : ["packages/docs/docs", "packages/docs", "docs", "launchdocs"];

  for (const dirName of dirs) {
    for (const filePath of walkMarkdownFiles(path.join(repoRoot, dirName))) {
      files.add(filePath);
    }
  }

  if (scope === "launchdocs") {
    return [...files].sort((left, right) => left.localeCompare(right));
  }

  const rootReadme = path.join(repoRoot, "README.md");
  if (exists(rootReadme)) {
    files.add(rootReadme);
  }

  const packagesDir = path.join(repoRoot, "packages");
  if (exists(packagesDir)) {
    for (const readme of walkReadmes(packagesDir)) {
      files.add(readme);
    }
  }

  return [...files].sort((left, right) => left.localeCompare(right));
}

function collectPackageScripts(repoRoot) {
  const scriptsByDir = new Map();
  const rootPackage = readJson(path.join(repoRoot, "package.json"));
  if (rootPackage?.scripts) {
    scriptsByDir.set(repoRoot, rootPackage.scripts);
  }

  for (const rootName of ["packages", "plugins", "cloud/packages"]) {
    const scanRoot = path.join(repoRoot, rootName);
    for (const packageJsonPath of walkPackageJsons(scanRoot)) {
      const packageJson = readJson(packageJsonPath);
      if (packageJson?.scripts) {
        scriptsByDir.set(path.dirname(packageJsonPath), packageJson.scripts);
      }
    }
  }

  return scriptsByDir;
}

function stripCodeFences(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, "");
}

function slugifyHeading(heading) {
  return heading
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~[\]]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function anchorsFor(markdown) {
  const anchors = new Set();
  const slugCounts = new Map();

  for (const match of markdown.matchAll(HEADING_RE)) {
    const base = slugifyHeading(match[2]);
    if (!base) {
      continue;
    }
    const count = slugCounts.get(base) ?? 0;
    slugCounts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }

  for (const match of markdown.matchAll(EXPLICIT_ANCHOR_RE)) {
    anchors.add(match[1]);
  }

  return anchors;
}

function isExternalTarget(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target);
}

function normalizeLinkTarget(rawTarget) {
  let target = rawTarget.trim();
  if (!target || isExternalTarget(target)) {
    return null;
  }

  target = target.replace(/^<|>$/g, "");
  const hashIndex = target.indexOf("#");
  const filePart = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const anchor = hashIndex === -1 ? "" : target.slice(hashIndex + 1);
  const cleanFilePart = filePart.split("?")[0];

  return {
    filePart: decodeURIComponent(cleanFilePart),
    anchor: decodeURIComponent(anchor),
  };
}

function candidatePaths(basePath) {
  const candidates = [basePath];
  if (!path.extname(basePath)) {
    candidates.push(`${basePath}.md`);
  }
  candidates.push(
    path.join(basePath, "README.md"),
    path.join(basePath, "index.md"),
  );
  return candidates;
}

function firstExistingPath(basePaths) {
  for (const basePath of basePaths) {
    for (const candidate of candidatePaths(basePath)) {
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function docsAliasPaths(repoRoot, filePart) {
  const parts = filePart.split(/[\\/]+/).filter(Boolean);
  const docsIndex = parts.lastIndexOf("docs");
  if (docsIndex === -1) {
    return [];
  }

  const docsRelativeParts = parts.slice(docsIndex + 1);
  return [
    path.join(repoRoot, "packages", "docs", "docs", ...docsRelativeParts),
    path.join(repoRoot, "packages", "docs", ...docsRelativeParts),
  ];
}

function resolveLinkedFile(repoRoot, fromFile, filePart) {
  if (!filePart) {
    return fromFile;
  }
  if (filePart.startsWith("/")) {
    const stripped = filePart.replace(/^\/+/, "");
    return (
      firstExistingPath([
        path.join(repoRoot, "packages", "docs", "docs", stripped),
        path.join(repoRoot, "packages", "docs", stripped),
        ...docsAliasPaths(repoRoot, stripped),
        path.join(repoRoot, "docs", stripped),
        path.join(repoRoot, stripped),
      ]) ?? path.join(repoRoot, "docs", stripped)
    );
  }

  const basePath = path.resolve(path.dirname(fromFile), filePart);
  return (
    firstExistingPath([basePath, ...docsAliasPaths(repoRoot, filePart)]) ??
    basePath
  );
}

function resolveAnchorFile(filePath) {
  if (!isDirectory(filePath)) {
    return filePath;
  }

  for (const candidate of ["README.md", "index.md"]) {
    const candidatePath = path.join(filePath, candidate);
    if (isFile(candidatePath)) {
      return candidatePath;
    }
  }

  return filePath;
}

function collectLinks(markdown) {
  const links = [];
  for (const match of markdown.matchAll(MARKDOWN_LINK_RE)) {
    if (match[0].startsWith("!")) {
      continue;
    }
    links.push(match[2]);
  }
  for (const match of markdown.matchAll(HTML_LINK_RE)) {
    links.push(match[1]);
  }
  return links;
}

function inferPackageDir(repoRoot, docFile) {
  const relative = rel(repoRoot, docFile);
  const match = relative.match(/^packages\/[^/]+\/README\.md$/);
  if (!match) {
    return repoRoot;
  }
  return path.join(repoRoot, relative.split("/").slice(0, 2).join("/"));
}

function normalizeCwd(repoRoot, docFile, cwdPart) {
  if (!cwdPart) {
    return inferPackageDir(repoRoot, docFile);
  }

  const stripped = cwdPart.replace(/^["']|["']$/g, "");
  if (stripped === ".") {
    return inferPackageDir(repoRoot, docFile);
  }
  const docRel = rel(repoRoot, docFile);
  const commandBase =
    docRel.startsWith("packages/docs/") ||
    docRel.startsWith("docs/") ||
    docRel.startsWith("launchdocs/")
      ? repoRoot
      : path.dirname(docFile);
  return path.resolve(commandBase, stripped);
}

function findNearestScriptDir(cwd, scriptsByDir, repoRoot) {
  let current = cwd;
  while (current.startsWith(repoRoot)) {
    if (scriptsByDir.has(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return repoRoot;
}

function findUniqueWorkspaceScriptDir(scriptName, scriptsByDir, repoRoot) {
  const matches = [];
  for (const [scriptDir, scripts] of scriptsByDir.entries()) {
    const relative = rel(repoRoot, scriptDir);
    if (
      Object.hasOwn(scripts, scriptName) &&
      !relative.startsWith("packages/elizaos/templates/")
    ) {
      matches.push(scriptDir);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function isLaunchdocsFile(repoRoot, filePath) {
  const relative = rel(repoRoot, filePath);
  return (
    relative.startsWith("packages/docs/docs/launchdocs/") ||
    relative.startsWith("packages/docs/launchdocs/") ||
    relative.startsWith("launchdocs/")
  );
}

function lineForOffset(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function checkLinks({ repoRoot, docFiles, contentByFile }) {
  const errors = [];
  const anchorCache = new Map();

  function getAnchors(filePath) {
    if (!anchorCache.has(filePath)) {
      const markdown =
        contentByFile.get(filePath) ?? fs.readFileSync(filePath, "utf8");
      anchorCache.set(filePath, anchorsFor(markdown));
    }
    return anchorCache.get(filePath);
  }

  for (const filePath of docFiles) {
    const markdown =
      contentByFile.get(filePath) ?? fs.readFileSync(filePath, "utf8");
    for (const rawTarget of collectLinks(stripCodeFences(markdown))) {
      const target = normalizeLinkTarget(rawTarget);
      if (!target) {
        continue;
      }

      const linkedFile = resolveLinkedFile(repoRoot, filePath, target.filePart);
      if (target.filePart && !exists(linkedFile)) {
        errors.push({
          type: "missing-file",
          file: rel(repoRoot, filePath),
          target: rawTarget,
          resolved: rel(repoRoot, linkedFile),
          message: `missing linked file ${rawTarget}`,
        });
        continue;
      }

      if (target.anchor) {
        const anchorFile = target.filePart
          ? resolveAnchorFile(linkedFile)
          : filePath;
        if (isFile(anchorFile) && !getAnchors(anchorFile).has(target.anchor)) {
          errors.push({
            type: "missing-anchor",
            file: rel(repoRoot, filePath),
            target: rawTarget,
            resolved: rel(repoRoot, anchorFile),
            anchor: target.anchor,
            message: `missing anchor #${target.anchor} in ${rel(repoRoot, anchorFile)}`,
          });
        }
      }
    }
  }

  return errors;
}

function checkCommands({ repoRoot, docFiles, contentByFile, scriptsByDir }) {
  const errors = [];

  for (const filePath of docFiles) {
    const markdown =
      contentByFile.get(filePath) ?? fs.readFileSync(filePath, "utf8");
    for (const match of markdown.matchAll(BUN_RUN_RE)) {
      const cdCwd = match[1];
      const cwdFlag = match[2];
      const scriptName = match[3];
      if (scriptName.startsWith("-")) {
        continue;
      }
      const commandCwd = normalizeCwd(repoRoot, filePath, cwdFlag ?? cdCwd);
      const scriptDir = findNearestScriptDir(
        commandCwd,
        scriptsByDir,
        repoRoot,
      );
      const scripts = scriptsByDir.get(scriptDir) ?? {};
      if (!Object.hasOwn(scripts, scriptName)) {
        if (isLaunchdocsFile(repoRoot, filePath)) {
          const workspaceScriptDir = findUniqueWorkspaceScriptDir(
            scriptName,
            scriptsByDir,
            repoRoot,
          );
          if (workspaceScriptDir) {
            continue;
          }
        }
        errors.push({
          type: "missing-script",
          file: rel(repoRoot, filePath),
          line: lineForOffset(markdown, match.index),
          script: scriptName,
          cwd: rel(repoRoot, scriptDir) || ".",
          message: `missing bun script "${scriptName}" in ${rel(repoRoot, scriptDir) || "."}`,
        });
      }
    }
  }

  return errors;
}

export function checkDocs(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const docFiles =
    options.docFiles?.map((filePath) => path.resolve(repoRoot, filePath)) ??
    collectDocs(repoRoot, options.scope ?? "all");
  const contentByFile = new Map();
  for (const filePath of docFiles) {
    contentByFile.set(filePath, fs.readFileSync(filePath, "utf8"));
  }
  const scriptsByDir = collectPackageScripts(repoRoot);
  const errors = [
    ...checkLinks({ repoRoot, docFiles, contentByFile }),
    ...checkCommands({ repoRoot, docFiles, contentByFile, scriptsByDir }),
  ];
  if (docFiles.length === 0) {
    errors.push({
      type: "no-docs",
      file: "",
      message: `no markdown files found for docs scope "${options.scope ?? "all"}"`,
    });
  }

  return {
    ok: errors.length === 0,
    checkedFiles: docFiles.map((filePath) => rel(repoRoot, filePath)),
    errorCount: errors.length,
    errors,
  };
}

function printHuman(result) {
  if (result.ok) {
    console.log(
      `[docs-gate] PASS checked ${result.checkedFiles.length} markdown file(s)`,
    );
    return;
  }

  console.error(
    `[docs-gate] FAIL ${result.errorCount} issue(s) across ${result.checkedFiles.length} markdown file(s)`,
  );
  for (const error of result.errors) {
    const where = error.line ? `${error.file}:${error.line}` : error.file;
    console.error(`- ${where} ${error.message}`);
  }
}

function parseArgs(argv) {
  const scope =
    argv.find((arg) => arg.startsWith("--scope="))?.slice("--scope=".length) ??
    (argv.includes("--launchdocs-only") ? "launchdocs" : undefined);
  return {
    json: argv.includes("--json"),
    scope,
    repoRoot:
      argv
        .find((arg) => arg.startsWith("--repo-root="))
        ?.slice("--repo-root=".length) ?? process.env.DOCS_GATE_REPO_ROOT,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = checkDocs({ repoRoot: args.repoRoot, scope: args.scope });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
  process.exit(result.ok ? 0 : 1);
}
