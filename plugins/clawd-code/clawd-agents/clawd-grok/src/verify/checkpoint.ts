import { execFile, spawn } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { VerifyRecipe } from "../types/index";
import type { SandboxSettings } from "../utils/settings";
import type { VerifyProjectProfile } from "./recipes";

const DEFAULT_VERIFY_GUEST_WORKDIR = "/grok/verify/worktree";

function execFileAsync(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, env: { ...process.env, FORCE_COLOR: "0" }, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || stdout || error.message).trim() || error.message));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function spawnWithProgress(
  command: string,
  args: string[],
  cwd: string,
  onLine?: (line: string) => void,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (onLine) {
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) onLine(trimmed);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (onLine) {
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (trimmed) onLine(trimmed);
        }
      }
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `Process exited with code ${code}`).trim()));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function stableRecipePayload(recipe: VerifyRecipe): string {
  return JSON.stringify({
    ecosystem: recipe.ecosystem,
    appKind: recipe.appKind,
    shellInitCommands: recipe.shellInitCommands,
    bootstrapCommands: recipe.bootstrapCommands,
    installCommands: recipe.installCommands,
    buildCommands: recipe.buildCommands,
    testCommands: recipe.testCommands,
    startCommand: recipe.startCommand,
    startPort: recipe.startPort,
    smokeKind: recipe.smokeKind,
  });
}

function readExistingFiles(cwd: string, files: string[]): Array<[string, string]> {
  return files
    .filter((file) => fs.existsSync(path.join(cwd, file)))
    .map((file) => [file, fs.readFileSync(path.join(cwd, file), "utf8")] as [string, string]);
}

function getRecipeFingerprint(cwd: string, recipe: VerifyRecipe): string {
  const manifestFiles = readExistingFiles(cwd, [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "Cargo.toml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Makefile",
  ]);

  return createHash("sha1")
    .update(stableRecipePayload(recipe))
    .update(JSON.stringify(manifestFiles))
    .digest("hex")
    .slice(0, 12);
}

export function buildVerifyCheckpointName(recipe: VerifyRecipe, fingerprint: string): string {
  const prefix = recipe.appKind.replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "app";
  return `verify-${prefix}-${fingerprint}`;
}

export function getVerifyCheckpointName(cwd: string, recipe: VerifyRecipe): string {
  return buildVerifyCheckpointName(recipe, getRecipeFingerprint(cwd, recipe));
}

async function listCheckpoints(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync("shuru", ["checkpoint", "list"], cwd);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0]);
}

async function deleteCheckpoint(cwd: string, checkpointName: string): Promise<void> {
  await execFileAsync("shuru", ["checkpoint", "delete", checkpointName], cwd);
}

function buildSyncScript(guestWorkdir: string): string {
  const exclusions = [
    ".git",
    "node_modules",
    ".venv",
    ".next",
    "dist",
    "build",
    "target",
    ".pytest_cache",
    ".mypy_cache",
  ];
  const preserveArgs = exclusions.map((entry) => `! -name '${entry}'`).join(" ");
  const tarExcludes = exclusions.map((entry) => `--exclude='${entry}'`).join(" ");
  return [
    `mkdir -p '${guestWorkdir}'`,
    `find '${guestWorkdir}' -mindepth 1 -maxdepth 1 ${preserveArgs} -exec rm -rf {} + 2>/dev/null || true`,
    `tar -C /workspace ${tarExcludes} -cf - . | tar -C '${guestWorkdir}' -xf -`,
  ].join(" && ");
}

function buildShellInitScript(settings: SandboxSettings, recipe: VerifyRecipe): string {
  const commands = settings.shellInit ?? recipe.shellInitCommands ?? [];
  return commands.filter(Boolean).join(" && ");
}

function buildCheckpointCreateArgs(
  cwd: string,
  checkpointName: string,
  guestWorkdir: string,
  recipe: VerifyRecipe,
  settings: SandboxSettings,
): string[] {
  const args = ["checkpoint", "create", checkpointName];
  const baseFrom = settings.verifyBaseFrom || settings.from;
  if (baseFrom) args.push("--from", baseFrom);
  if (settings.cpus) args.push("--cpus", String(settings.cpus));
  if (settings.memory) args.push("--memory", String(settings.memory));
  if (settings.diskSize) args.push("--disk-size", String(settings.diskSize));
  if (settings.allowNet || recipe.installCommands.length > 0) args.push("--allow-net");
  if (settings.allowedHosts) {
    for (const host of settings.allowedHosts) args.push("--allow-host", host);
  }
  if (settings.secrets) {
    for (const secret of settings.secrets) {
      args.push("--secret", `${secret.name}=${secret.fromEnv}@${secret.hosts.join(",")}`);
    }
  }
  args.push("--mount", `${cwd}:/workspace`);

  const shellInitScript = buildShellInitScript(settings, recipe);
  const bootstrapScript = recipe.bootstrapCommands.join(" && ") || "true";
  const installScript = recipe.installCommands.join(" && ") || "true";
  const script = [
    buildSyncScript(guestWorkdir),
    shellInitScript,
    bootstrapScript,
    `cd '${guestWorkdir}'`,
    installScript,
  ]
    .filter(Boolean)
    .join(" && ");
  args.push("--", "sh", "-lc", script);
  return args;
}

export interface PreparedVerifyCheckpoint {
  checkpointName?: string;
  guestWorkdir?: string;
  created: boolean;
}

export async function ensureVerifyCheckpoint(
  cwd: string,
  profile: VerifyProjectProfile,
  settings: SandboxSettings,
  onProgress?: (detail: string) => void,
): Promise<PreparedVerifyCheckpoint> {
  if (profile.recipe.installCommands.length === 0) {
    return { created: false };
  }

  const checkpointName = getVerifyCheckpointName(cwd, profile.recipe);
  const checkpoints: string[] = await listCheckpoints(cwd).catch((): string[] => []);
  if (!checkpoints.includes(checkpointName)) {
    const args = buildCheckpointCreateArgs(cwd, checkpointName, DEFAULT_VERIFY_GUEST_WORKDIR, profile.recipe, settings);
    onProgress?.(`Creating checkpoint: ${checkpointName}`);
    try {
      await spawnWithProgress("shuru", args, cwd, onProgress);
    } catch (error) {
      await deleteCheckpoint(cwd, checkpointName).catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Verify checkpoint bootstrap failed for "${checkpointName}": ${message}`);
    }
    return { checkpointName, guestWorkdir: DEFAULT_VERIFY_GUEST_WORKDIR, created: true };
  }

  onProgress?.(`Reusing checkpoint: ${checkpointName}`);
  return { checkpointName, guestWorkdir: DEFAULT_VERIFY_GUEST_WORKDIR, created: false };
}
