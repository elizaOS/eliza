import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FullstackTemplateValues,
  PluginTemplateValues,
  ProjectTemplateMetadata,
  TemplateDefinition,
  TemplateUpstream,
} from "./types.js";

const SKIP_NAMES = new Set([
  ".DS_Store",
  ".git",
  ".turbo",
  ".vite",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".pdf",
  ".zip",
  ".gz",
  ".wasm",
  ".dylib",
  ".dll",
  ".so",
]);
function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function ensureGitRepository(projectRoot: string): void {
  const gitDir = path.join(projectRoot, ".git");
  if (!fs.existsSync(gitDir)) {
    execFileSync("git", ["init", "-q"], { cwd: projectRoot });
  }
}

function isLocalRepoSpec(repo: string): boolean {
  return (
    path.isAbsolute(repo) ||
    repo.startsWith("./") ||
    repo.startsWith("../") ||
    repo.startsWith("file://")
  );
}

function withOptionalFileProtocol(repo: string, args: string[]): string[] {
  if (!isLocalRepoSpec(repo)) {
    return args;
  }
  return ["-c", "protocol.file.allow=always", ...args];
}

function resolveLocalRepoRoot(repo: string): string | undefined {
  if (!isLocalRepoSpec(repo)) {
    return undefined;
  }
  if (repo.startsWith("file://")) {
    return fileURLToPath(repo);
  }
  return path.resolve(repo);
}

function isShallowGitRepo(repoRoot: string): boolean {
  if (!fs.existsSync(path.join(repoRoot, ".git"))) {
    return false;
  }
  try {
    const result = execFileSync(
      "git",
      ["rev-parse", "--is-shallow-repository"],
      { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return result.trim() === "true";
  } catch {
    return false;
  }
}

function resolveReferenceRepoRoot(repo: string): string | undefined {
  const localRepoRoot = resolveLocalRepoRoot(repo);
  if (!localRepoRoot) {
    return undefined;
  }
  if (isShallowGitRepo(localRepoRoot)) {
    return undefined;
  }
  return localRepoRoot;
}

function isBinaryFile(filePath: string, buffer: Buffer): boolean {
  if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return true;
  }
  return buffer.includes(0);
}

function replaceAll(
  text: string,
  replacements: Array<[string, string]>,
): string {
  let next = text;
  for (const [from, to] of replacements.sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    next = next.split(from).join(to);
  }
  return next;
}

function requireStringKeys<T extends Record<string, string>>(
  values: Record<string, string>,
  keys: readonly (keyof T & string)[],
  templateId: TemplateDefinition["id"],
): T {
  const missing = keys.filter((key) => typeof values[key] !== "string");
  if (missing.length > 0) {
    throw new Error(
      `Template "${templateId}" values missing required keys: ${missing.join(", ")}`,
    );
  }
  return values as T;
}

const PLUGIN_TEMPLATE_VALUE_KEYS = [
  "displayName",
  "elizaVersion",
  "githubUsername",
  "pluginBaseName",
  "pluginDescription",
  "pluginSnake",
  "repoUrl",
] as const satisfies readonly (keyof PluginTemplateValues & string)[];

const FULLSTACK_TEMPLATE_VALUE_KEYS = [
  "appName",
  "appUrl",
  "bugReportUrl",
  "bundleId",
  "docsUrl",
  "fileExtension",
  "hashtag",
  "orgName",
  "packageScope",
  "projectSlug",
  "releaseBaseUrl",
  "repoName",
] as const satisfies readonly (keyof FullstackTemplateValues & string)[];

function normalizeKebabCase(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "project";
}

export function toDisplayName(value: string): string {
  return normalizeKebabCase(value)
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function buildPluginTemplateValues(input: {
  elizaVersion: string;
  githubUsername: string;
  pluginDescription: string;
  projectName: string;
  repoUrl: string;
}): PluginTemplateValues {
  const slug = normalizeKebabCase(input.projectName);
  const pluginBaseName = slug.startsWith("plugin-") ? slug : `plugin-${slug}`;
  return {
    displayName: toDisplayName(pluginBaseName.replace(/^plugin-/, "")),
    elizaVersion: input.elizaVersion,
    githubUsername: input.githubUsername,
    pluginBaseName,
    pluginDescription: input.pluginDescription,
    pluginSnake: pluginBaseName.replace(/-/g, "_"),
    repoUrl: input.repoUrl,
  };
}

export function buildFullstackTemplateValues(
  projectName: string,
): FullstackTemplateValues {
  const projectSlug = normalizeKebabCase(projectName);
  const packageScope = projectSlug.replace(/[^a-z0-9]/g, "");
  const appName = toDisplayName(projectSlug);
  const appUrl = `https://example.com/${projectSlug}`;
  return {
    appName,
    appUrl,
    bugReportUrl: `https://github.com/your-org/${projectSlug}/issues/new`,
    bundleId: `com.example.${packageScope || "app"}`,
    docsUrl: `${appUrl}/docs`,
    fileExtension: `.${projectSlug}.agent`,
    hashtag: `#${appName.replace(/\s+/g, "")}`,
    orgName: "your-org",
    packageScope: packageScope || "app",
    projectSlug,
    releaseBaseUrl: `${appUrl}/releases/`,
    repoName: projectSlug,
  };
}

export function getPluginReplacementEntries(
  values: PluginTemplateValues,
): Array<[string, string]> {
  return [
    [`\${PLUGINNAME}`, values.pluginBaseName],
    [`\${PLUGINDESCRIPTION}`, values.pluginDescription],
    [`\${GITHUB_USERNAME}`, values.githubUsername],
    [`\${REPO_URL}`, values.repoUrl],
    ["__ELIZAOS_VERSION__", values.elizaVersion],
    ["@elizaos/plugin-starter", `@elizaos/${values.pluginBaseName}`],
    ["elizaos_plugin_starter", `elizaos_${values.pluginSnake}`],
    ["elizaos-plugin-starter", `elizaos-${values.pluginBaseName}`],
    ["plugin_starter", values.pluginSnake],
    ["plugin-starter", values.pluginBaseName],
    ["Plugin starter", `${values.displayName} plugin`],
    ["plugin starter", `${values.displayName.toLowerCase()} plugin`],
    [
      "plugin starter template",
      `${values.displayName.toLowerCase()} plugin template`,
    ],
  ];
}

export function getFullstackReplacementEntries(
  values: FullstackTemplateValues,
): Array<[string, string]> {
  return [
    ["__PROJECT_SLUG__", values.projectSlug],
    ["__APP_NAME__", values.appName],
    ["__APP_PACKAGE_NAME__", `${values.projectSlug}-app`],
    ["__ELECTROBUN_PACKAGE_NAME__", `${values.projectSlug}-electrobun`],
    ["__APP_URL__", values.appUrl],
    ["__BUG_REPORT_URL__", values.bugReportUrl],
    ["__BUNDLE_ID__", values.bundleId],
    ["__DOCS_URL__", values.docsUrl],
    ["__FILE_EXTENSION__", values.fileExtension],
    ["__HASHTAG__", values.hashtag],
    ["__ORG_NAME__", values.orgName],
    ["__PACKAGE_SCOPE__", values.packageScope],
    ["__RELEASE_BASE_URL__", values.releaseBaseUrl],
    ["__REPO_NAME__", values.repoName],
  ];
}

export function getTemplateReplacementEntries(options: {
  templateId: TemplateDefinition["id"];
  values: Record<string, string>;
}): Array<[string, string]> {
  if (options.templateId === "plugin") {
    return getPluginReplacementEntries(
      requireStringKeys<PluginTemplateValues>(
        options.values,
        PLUGIN_TEMPLATE_VALUE_KEYS,
        options.templateId,
      ),
    );
  }
  return getFullstackReplacementEntries(
    requireStringKeys<FullstackTemplateValues>(
      options.values,
      FULLSTACK_TEMPLATE_VALUE_KEYS,
      options.templateId,
    ),
  );
}

export function resolveTemplateSourceDir(options: {
  template: TemplateDefinition;
  templatesDir: string;
}): string {
  return path.join(options.templatesDir, options.template.id);
}

function copyRenderedTreeInternal(
  sourceDir: string,
  destinationDir: string,
  replacements: Array<[string, string]>,
  managedFiles: Record<string, string>,
  rootDir: string,
): void {
  fs.mkdirSync(destinationDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name) || entry.name === "template.json") {
      continue;
    }

    const renderedEntryName = replaceAll(entry.name, replacements);
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, renderedEntryName);
    if (entry.isDirectory()) {
      copyRenderedTreeInternal(
        sourcePath,
        destinationPath,
        replacements,
        managedFiles,
        rootDir,
      );
      continue;
    }

    const relativePath = path.relative(rootDir, destinationPath);
    const buffer = fs.readFileSync(sourcePath);
    if (isBinaryFile(sourcePath, buffer)) {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.writeFileSync(destinationPath, buffer);
      managedFiles[relativePath] = sha256(buffer);
      continue;
    }

    const rendered = replaceAll(buffer.toString("utf-8"), replacements);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, rendered, "utf-8");
    managedFiles[relativePath] = sha256(rendered);
  }
}

export function renderTemplateTree(options: {
  destinationDir: string;
  replacements: Array<[string, string]>;
  sourceDir: string;
}): Record<string, string> {
  const managedFiles: Record<string, string> = {};
  copyRenderedTreeInternal(
    options.sourceDir,
    options.destinationDir,
    options.replacements,
    managedFiles,
    options.destinationDir,
  );
  return managedFiles;
}

export function createRenderedTempDir(options: {
  replacements: Array<[string, string]>;
  sourceDir: string;
}): { dir: string; managedFiles: Record<string, string> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elizaos-template-"));
  const managedFiles = renderTemplateTree({
    destinationDir: dir,
    replacements: options.replacements,
    sourceDir: options.sourceDir,
  });
  return { dir, managedFiles };
}

export function resolveTemplateUpstream(
  upstream: TemplateUpstream,
): TemplateUpstream {
  const hasEnvBranch = Object.hasOwn(process.env, "ELIZAOS_UPSTREAM_BRANCH");
  const envRepo = process.env.ELIZAOS_UPSTREAM_REPO?.trim();
  const envBranch = process.env.ELIZAOS_UPSTREAM_BRANCH?.trim();
  return {
    ...upstream,
    branch: hasEnvBranch ? envBranch || undefined : upstream.branch,
    repo: envRepo || upstream.repo,
  };
}

export function ensurePackageJsonWorkspaces(
  packageJsonPath: string,
  workspaceEntries: string[],
): boolean {
  if (workspaceEntries.length === 0 || !fs.existsSync(packageJsonPath)) {
    return false;
  }

  const raw = fs.readFileSync(packageJsonPath, "utf8");
  const pkg = JSON.parse(raw) as { workspaces?: string[] };
  if (!Array.isArray(pkg.workspaces)) {
    return false;
  }

  let changed = false;
  for (const entry of workspaceEntries) {
    if (!pkg.workspaces.includes(entry)) {
      pkg.workspaces.push(entry);
      changed = true;
    }
  }

  if (!changed) {
    return false;
  }

  const indent = raw.match(/^(\s+)"/m)?.[1] || "  ";
  fs.writeFileSync(
    packageJsonPath,
    `${JSON.stringify(pkg, null, indent)}\n`,
    "utf8",
  );
  return true;
}

export function buildMetadata(options: {
  cliVersion: string;
  language?: string;
  managedFiles: Record<string, string>;
  template: TemplateDefinition;
  values: Record<string, string>;
}): ProjectTemplateMetadata {
  const now = new Date().toISOString();
  return {
    cliVersion: options.cliVersion,
    createdAt: now,
    language: options.language,
    managedFiles: options.managedFiles,
    templateId: options.template.id,
    templateVersion: options.template.version,
    updatedAt: now,
    values: options.values,
  };
}

export function updateManagedFiles(options: {
  currentMetadata: ProjectTemplateMetadata;
  dryRun?: boolean;
  projectRoot: string;
  renderedDir: string;
  renderedManagedFiles: Record<string, string>;
}): {
  conflicts: string[];
  created: string[];
  deleted: string[];
  nextManagedFiles: Record<string, string>;
  unchanged: string[];
  updated: string[];
} {
  const conflicts: string[] = [];
  const created: string[] = [];
  const deleted: string[] = [];
  const unchanged: string[] = [];
  const updated: string[] = [];
  const nextManagedFiles = { ...options.renderedManagedFiles };

  const previousFiles = options.currentMetadata.managedFiles;
  const allManagedPaths = new Set([
    ...Object.keys(previousFiles),
    ...Object.keys(options.renderedManagedFiles),
  ]);

  for (const relativePath of allManagedPaths) {
    const projectPath = path.join(options.projectRoot, relativePath);
    const renderedPath = path.join(options.renderedDir, relativePath);
    const previousHash = previousFiles[relativePath];
    const nextHash = options.renderedManagedFiles[relativePath];
    const hasCurrentFile = fs.existsSync(projectPath);
    const hasRenderedFile = fs.existsSync(renderedPath);
    const currentHash = hasCurrentFile
      ? sha256(fs.readFileSync(projectPath))
      : "";

    if (previousHash && !hasRenderedFile) {
      if (currentHash && currentHash !== previousHash) {
        conflicts.push(relativePath);
        delete nextManagedFiles[relativePath];
        continue;
      }
      deleted.push(relativePath);
      delete nextManagedFiles[relativePath];
      if (!options.dryRun && fs.existsSync(projectPath)) {
        fs.rmSync(projectPath, { force: true });
      }
      continue;
    }

    if (!previousHash && nextHash) {
      if (currentHash && currentHash !== nextHash) {
        conflicts.push(relativePath);
        continue;
      }
      created.push(relativePath);
      if (!options.dryRun) {
        fs.mkdirSync(path.dirname(projectPath), { recursive: true });
        fs.copyFileSync(renderedPath, projectPath);
      }
      continue;
    }

    if (currentHash === previousHash) {
      if (currentHash === nextHash) {
        unchanged.push(relativePath);
        continue;
      }
      updated.push(relativePath);
      if (!options.dryRun) {
        fs.mkdirSync(path.dirname(projectPath), { recursive: true });
        fs.copyFileSync(renderedPath, projectPath);
      }
      continue;
    }

    if (currentHash === nextHash) {
      unchanged.push(relativePath);
      continue;
    }

    conflicts.push(relativePath);
    delete nextManagedFiles[relativePath];
  }

  return {
    conflicts,
    created,
    deleted,
    nextManagedFiles,
    unchanged,
    updated,
  };
}

export function hydrateGitSubmoduleWorkspace(options: {
  dryRun?: boolean;
  projectRoot: string;
  upstream: TemplateUpstream;
}): void {
  if (options.dryRun) {
    return;
  }

  const submoduleRoot = path.join(options.projectRoot, options.upstream.path);
  if (!fs.existsSync(submoduleRoot)) {
    return;
  }

  const requiredSubmodules = options.upstream.requiredSubmodules ?? [];
  const localRepoRoot = resolveLocalRepoRoot(options.upstream.repo);

  for (const submodulePath of requiredSubmodules) {
    const command = ["submodule", "update", "--init", "--recursive"];
    let localSubmoduleRoot: string | undefined;

    if (localRepoRoot) {
      const candidate = path.join(localRepoRoot, submodulePath);
      if (fs.existsSync(candidate)) {
        execFileSync(
          "git",
          ["config", `submodule.${submodulePath}.url`, candidate],
          { cwd: submoduleRoot, stdio: "inherit" },
        );
        localSubmoduleRoot = candidate;
      }
    }

    const referenceRoot =
      localSubmoduleRoot && !isShallowGitRepo(localSubmoduleRoot)
        ? localSubmoduleRoot
        : undefined;
    if (referenceRoot) {
      command.push("--reference", referenceRoot);
    }
    command.push(submodulePath);
    execFileSync(
      "git",
      localSubmoduleRoot
        ? withOptionalFileProtocol(localSubmoduleRoot, command)
        : command,
      { cwd: submoduleRoot, stdio: "inherit" },
    );
  }

  ensurePackageJsonWorkspaces(
    path.join(submoduleRoot, "package.json"),
    options.upstream.requiredWorkspaces ?? [],
  );
}

export function initializeGitSubmodule(options: {
  branch?: string;
  projectRoot: string;
  repo: string;
  submodulePath: string;
}): void {
  ensureGitRepository(options.projectRoot);

  const submoduleRoot = path.join(options.projectRoot, options.submodulePath);
  if (fs.existsSync(submoduleRoot)) {
    return;
  }

  const args = ["submodule", "add", "--depth", "1"];
  const referenceRoot = resolveReferenceRepoRoot(options.repo);
  if (referenceRoot) {
    args.push("--reference", referenceRoot);
  }
  if (options.branch?.trim()) {
    args.push("-b", options.branch.trim());
  }
  args.push(options.repo, options.submodulePath);
  execFileSync("git", withOptionalFileProtocol(options.repo, args), {
    cwd: options.projectRoot,
    stdio: "inherit",
  });
}

export function updateGitSubmodule(options: {
  branch?: string;
  dryRun?: boolean;
  projectRoot: string;
  repo: string;
  submodulePath: string;
}): void {
  if (options.dryRun) {
    return;
  }

  ensureGitRepository(options.projectRoot);
  const submoduleRoot = path.join(options.projectRoot, options.submodulePath);
  if (!fs.existsSync(submoduleRoot)) {
    initializeGitSubmodule({
      branch: options.branch,
      projectRoot: options.projectRoot,
      repo: options.repo,
      submodulePath: options.submodulePath,
    });
    return;
  }

  const referenceRoot = resolveReferenceRepoRoot(options.repo);
  execFileSync(
    "git",
    withOptionalFileProtocol(options.repo, [
      "submodule",
      "update",
      "--init",
      "--remote",
      ...(referenceRoot ? ["--reference", referenceRoot] : []),
      options.submodulePath,
    ]),
    { cwd: options.projectRoot, stdio: "inherit" },
  );
}
