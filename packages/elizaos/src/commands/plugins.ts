import * as clack from "@clack/prompts";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import pc from "picocolors";

interface SubmitOptions {
  registry: string;
  base: string;
  dryRun?: boolean;
  pr?: boolean;
  yes?: boolean;
  skipValidation?: boolean;
}

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  homepage?: string;
  keywords?: string[];
  repository?: string | { type?: string; url?: string; directory?: string };
  elizaos?: {
    kind?: string;
    app?: Record<string, unknown>;
  };
}

interface ThirdPartyMetadata {
  package: string;
  repository: string;
  kind: "plugin" | "connector" | "app";
  description?: string;
  homepage?: string;
  version?: string;
  directory?: string;
  tags?: string[];
  app?: Record<string, unknown>;
}

const PACKAGE_NAME_RE =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VALID_KINDS = new Set(["plugin", "connector", "app"]);

export function registerPluginsCommand(program: Command): void {
  const plugins = program
    .command("plugins")
    .description("Manage elizaOS plugin registry submissions");

  plugins
    .command("submit")
    .description("Submit the current plugin project to the registry")
    .argument("[path]", "Plugin project directory", ".")
    .option(
      "--registry <owner/repo>",
      "Registry GitHub repository",
      "elizaos-plugins/registry",
    )
    .option("--base <branch>", "Registry base branch", "main")
    .option("--dry-run", "Print generated metadata without writing or opening a PR")
    .option("--no-pr", "Create and push the branch but do not open a PR")
    .option("-y, --yes", "Skip confirmation prompts")
    .option("--skip-validation", "Skip npm and GitHub existence checks")
    .action(submitPluginToRegistry);
}

export async function submitPluginToRegistry(
  projectPath = ".",
  options: SubmitOptions,
): Promise<void> {
  if (!GITHUB_REPO_RE.test(options.registry)) {
    throw new Error(`Invalid registry repository: ${options.registry}`);
  }
  const projectDir = path.resolve(projectPath);
  const metadata = createThirdPartyMetadata(projectDir);
  const fileName = metadataFileName(metadata.package);
  const relativeRegistryPath = path.join("entries", "third-party", fileName);

  if (options.dryRun) {
    console.log(JSON.stringify({ path: relativeRegistryPath, metadata }, null, 2));
    return;
  }

  if (!options.skipValidation) {
    validatePublishedPackage(metadata.package);
    validateGithubRepository(metadata.repository);
  }

  if (!options.yes) {
    const confirmed = await clack.confirm({
      message: `Open a registry PR for ${metadata.package}?`,
      initialValue: true,
    });
    if (clack.isCancel(confirmed) || !confirmed) {
      clack.cancel("Registry submission cancelled.");
      return;
    }
  }

  ensureCommand("git", ["--version"]);
  ensureCommand("gh", ["--version"]);
  ensureCommand("gh", ["auth", "status"]);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "elizaos-registry-"));
  const checkoutDir = path.join(tempDir, "registry");
  const branchName = `add-${sanitizeBranchPart(metadata.package)}-to-registry`;

  try {
    const ghUser = capture("gh", ["api", "user", "--jq", ".login"]).trim();
    ensureFork(options.registry);

    run("git", ["clone", `https://github.com/${options.registry}.git`, checkoutDir]);
    run("git", ["checkout", "-b", branchName], { cwd: checkoutDir });

    const targetFile = path.join(checkoutDir, relativeRegistryPath);
    if (fs.existsSync(targetFile)) {
      throw new Error(`${relativeRegistryPath} already exists in the registry`);
    }

    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, `${JSON.stringify(metadata, null, 2)}\n`);

    run("git", ["add", relativeRegistryPath], { cwd: checkoutDir });
    run("git", ["commit", "-m", `Register ${metadata.package}`], {
      cwd: checkoutDir,
    });

    const repoName = options.registry.split("/")[1];
    run(
      "git",
      [
        "remote",
        "add",
        "fork",
        `https://github.com/${ghUser}/${repoName}.git`,
      ],
      { cwd: checkoutDir },
    );
    run("git", ["push", "-u", "fork", branchName], { cwd: checkoutDir });

    if (options.pr === false) {
      console.log(
        pc.green(
          `Pushed ${branchName}. Open a PR from ${ghUser}:${branchName} to ${options.registry}:${options.base}.`,
        ),
      );
      return;
    }

    const prUrl = capture(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        options.registry,
        "--base",
        options.base,
        "--head",
        `${ghUser}:${branchName}`,
        "--title",
        `Register ${metadata.package}`,
        "--body",
        prBody(metadata),
      ],
      { cwd: checkoutDir },
    ).trim();

    console.log(pc.green(`Created registry PR: ${prUrl}`));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function createThirdPartyMetadata(projectDir: string): ThirdPartyMetadata {
  const packageJsonPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`No package.json found at ${packageJsonPath}`);
  }

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PackageJson;
  const packageName = pkg.name?.trim();
  if (!packageName || !PACKAGE_NAME_RE.test(packageName)) {
    throw new Error(`Invalid or missing package name in ${packageJsonPath}`);
  }
  if (packageName.startsWith("@elizaos/")) {
    throw new Error("@elizaos/* is reserved for first-party built-in packages");
  }

  const repo =
    normalizeGithubRepo(repositoryValue(pkg.repository)) ||
    normalizeGithubRepo(pkg.homepage) ||
    inferGithubRepoFromGit(projectDir);
  if (!repo || !GITHUB_REPO_RE.test(repo)) {
    throw new Error(
      "Could not infer a GitHub repository. Add repository.url to package.json.",
    );
  }

  const kind = normalizeKind(pkg.elizaos?.kind, packageName);
  const metadata: ThirdPartyMetadata = {
    package: packageName,
    repository: `github:${repo}`,
    kind,
  };

  if (pkg.description?.trim()) {
    metadata.description = pkg.description.trim();
  }
  if (pkg.homepage?.trim()) {
    metadata.homepage = pkg.homepage.trim();
  }
  if (pkg.version?.trim()) {
    metadata.version = pkg.version.trim();
  }
  if (typeof pkg.repository === "object" && pkg.repository.directory?.trim()) {
    metadata.directory = pkg.repository.directory.trim();
  }
  const tags = Array.isArray(pkg.keywords)
    ? pkg.keywords.filter((tag) => typeof tag === "string" && tag.trim())
    : [];
  if (tags.length > 0) {
    metadata.tags = [...new Set(tags.map((tag) => tag.trim()))];
  }
  if (kind === "app" && pkg.elizaos?.app) {
    metadata.app = pkg.elizaos.app;
  }

  return metadata;
}

export function normalizeGithubRepo(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  let input = value.trim();
  if (!input) {
    return null;
  }
  if (input.startsWith("github:")) {
    input = input.slice("github:".length);
  } else if (input.startsWith("git+")) {
    input = input.slice("git+".length);
  }
  input = input
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .replace(/\/tree\/.*$/, "")
    .replace(/\/blob\/.*$/, "")
    .replace(/#.*$/, "");
  const [owner, repo] = input.split("/");
  return owner && repo ? `${owner}/${repo}` : null;
}

function repositoryValue(repository: PackageJson["repository"]): string | null {
  if (!repository) {
    return null;
  }
  if (typeof repository === "string") {
    return repository;
  }
  return repository.url || null;
}

function inferGithubRepoFromGit(projectDir: string): string | null {
  try {
    const remote = capture("git", ["config", "--get", "remote.origin.url"], {
      cwd: projectDir,
      quiet: true,
    });
    return normalizeGithubRepo(remote);
  } catch {
    return null;
  }
}

function normalizeKind(
  declaredKind: string | undefined,
  packageName: string,
): "plugin" | "connector" | "app" {
  if (declaredKind && VALID_KINDS.has(declaredKind)) {
    return declaredKind as "plugin" | "connector" | "app";
  }
  if (packageName.includes("/app-") || packageName.startsWith("app-")) {
    return "app";
  }
  return "plugin";
}

function metadataFileName(packageName: string): string {
  return `${packageName
    .replace(/^@/, "")
    .replace(/\//g, "__")
    .replace(/[^a-zA-Z0-9._-]/g, "-")}.json`;
}

function sanitizeBranchPart(packageName: string): string {
  return packageName
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function validatePublishedPackage(packageName: string): void {
  ensureCommand("npm", ["view", packageName, "version"]);
}

function validateGithubRepository(repository: string): void {
  const repo = repository.replace(/^github:/, "");
  ensureCommand("git", ["ls-remote", `https://github.com/${repo}.git`, "HEAD"]);
}

function ensureFork(registry: string): void {
  const result = spawnSync("gh", ["repo", "fork", registry, "--clone=false"], {
    encoding: "utf8",
  });
  if (result.status === 0) {
    return;
  }
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (/already exists|already forked/i.test(combined)) {
    return;
  }
  throw new Error(combined.trim() || `gh repo fork ${registry} failed`);
}

function prBody(metadata: ThirdPartyMetadata): string {
  return [
    `Registers \`${metadata.package}\` as a third-party elizaOS package.`,
    "",
    `Repository: ${metadata.repository}`,
    `Kind: ${metadata.kind}`,
    "",
    "This package is community supported and not first-party supported.",
  ].join("\n");
}

function ensureCommand(command: string, args: string[]): void {
  run(command, args, { quiet: true });
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; quiet?: boolean } = {},
): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.quiet ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
    throw new Error(output || `${command} ${args.join(" ")} failed`);
  }
}

function capture(
  command: string,
  args: string[],
  options: { cwd?: string; quiet?: boolean } = {},
): string {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", options.quiet ? "ignore" : "pipe"],
  });
}
