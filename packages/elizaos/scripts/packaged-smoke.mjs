import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const tmpBaseDir =
  process.env.ELIZAOS_SMOKE_TMPDIR ||
  (fs.existsSync("/tmp") ? "/tmp" : os.tmpdir());
const tmpRoot = fs.mkdtempSync(
  path.join(tmpBaseDir, "elizaos-packaged-smoke-"),
);
const shouldKeepTemp = process.env.ELIZAOS_SMOKE_KEEP_TEMP === "1";
const shouldInstallGeneratedFullstack =
  process.env.ELIZAOS_SMOKE_FULLSTACK_INSTALL === "1";
const shouldSmokeEject = process.env.ELIZAOS_SMOKE_EJECT === "1";
const shouldUseRemoteUpstream =
  process.env.ELIZAOS_SMOKE_REMOTE_UPSTREAM === "1";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const bunCommand = process.platform === "win32" ? "bun.exe" : "bun";
const elizaosBinName = process.platform === "win32" ? "elizaos.cmd" : "elizaos";
const localUpstreamRepo = path.resolve(packageDir, "..", "..");
const cliEnv =
  !shouldUseRemoteUpstream &&
  fs.existsSync(
    path.join(localUpstreamRepo, "packages", "app-core", "package.json"),
  )
    ? {
        ...process.env,
        ELIZAOS_UPSTREAM_BRANCH: process.env.ELIZAOS_UPSTREAM_BRANCH ?? "",
        ELIZAOS_UPSTREAM_REPO:
          process.env.ELIZAOS_UPSTREAM_REPO || localUpstreamRepo,
      }
    : process.env;
const fullstackInstallEnv = {
  ...process.env,
  ELIZA_NO_VISION_DEPS: process.env.ELIZA_NO_VISION_DEPS || "1",
  SKIP_AVATAR_CLONE: process.env.SKIP_AVATAR_CLONE || "1",
};

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function commandExists(command) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command]);
    return true;
  } catch {
    return false;
  }
}

function packCliPackage() {
  if (commandExists(npmCommand)) {
    return run(npmCommand, ["pack", packageDir, "--pack-destination", tmpRoot]);
  }

  if (!commandExists(bunCommand)) {
    throw new Error("Neither npm nor bun is available for packaged smoke test");
  }

  return run(bunCommand, ["pm", "pack", "--destination", tmpRoot, "--quiet"], {
    cwd: packageDir,
  });
}

function installCliPackage(smokeDir, tarballPath) {
  if (commandExists(npmCommand)) {
    run(npmCommand, ["install", tarballPath], { cwd: smokeDir });
    return;
  }

  run(bunCommand, ["add", tarballPath], { cwd: smokeDir });
}

function getTarballName(output) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tarball = [...lines].reverse().find((line) => line.endsWith(".tgz"));
  if (!tarball) {
    throw new Error(
      `Unable to determine tarball name from npm pack output:\n${output}`,
    );
  }
  return tarball;
}

function getInstalledCli(smokeDir) {
  return path.join(smokeDir, "node_modules", ".bin", elizaosBinName);
}

function assertPathExists(targetPath) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Expected path to exist: ${targetPath}`);
  }
}

function assertPathMissing(targetPath) {
  if (fs.existsSync(targetPath)) {
    throw new Error(`Expected path to be absent: ${targetPath}`);
  }
}

function runCli(smokeDir, cwd, args) {
  return run(getInstalledCli(smokeDir), args, { cwd, env: cliEnv });
}

function main() {
  let passed = false;

  try {
    run("bun", ["run", "build"], { cwd: packageDir });

    const packOutput = packCliPackage();
    const tarballName = getTarballName(packOutput);
    const tarballPath = path.isAbsolute(tarballName)
      ? tarballName
      : path.join(tmpRoot, tarballName);
    const smokeDir = path.join(tmpRoot, "smoke");
    fs.mkdirSync(smokeDir, { recursive: true });
    fs.writeFileSync(
      path.join(smokeDir, "package.json"),
      `${JSON.stringify({ name: "elizaos-packaged-smoke", private: true }, null, 2)}\n`,
    );
    installCliPackage(smokeDir, tarballPath);

    runCli(smokeDir, smokeDir, ["info"]);

    const workspaceDir = path.join(smokeDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });

    runCli(smokeDir, workspaceDir, [
      "create",
      "plugin-demo",
      "--template",
      "plugin",
      "--language",
      "typescript",
      "--yes",
    ]);
    const pluginDir = path.join(workspaceDir, "plugin-demo");
    assertPathExists(path.join(pluginDir, "package.json"));
    assertPathExists(path.join(pluginDir, ".elizaos", "template.json"));
    if (shouldInstallGeneratedFullstack) {
      run("bun", ["install"], { cwd: pluginDir });
      run("bun", ["run", "typecheck"], { cwd: pluginDir });
      run("bun", ["run", "build"], { cwd: pluginDir });
    }
    runCli(smokeDir, pluginDir, ["upgrade", "--check"]);

    runCli(smokeDir, workspaceDir, [
      "create",
      "project-demo",
      "--template",
      "project",
      "--yes",
    ]);
    const projectDir = path.join(workspaceDir, "project-demo");
    assertPathExists(path.join(projectDir, "package.json"));
    assertPathExists(path.join(projectDir, ".elizaos", "template.json"));
    assertPathExists(path.join(projectDir, "apps", "app", "package.json"));
    assertPathMissing(path.join(projectDir, "eliza"));
    const packageModeOutput = run(
      "node",
      ["scripts/eliza-source-mode.mjs", "packages"],
      { cwd: projectDir },
    );
    if (!packageModeOutput.includes("beta")) {
      throw new Error(
        `Expected generated package mode to default to beta. Output:\n${packageModeOutput}`,
      );
    }
    if (shouldInstallGeneratedFullstack) {
      run("bun", ["install"], { cwd: projectDir, env: fullstackInstallEnv });
      run("bun", ["run", "typecheck"], {
        cwd: projectDir,
        env: fullstackInstallEnv,
      });
      run("bun", ["run", "build"], {
        cwd: projectDir,
        env: fullstackInstallEnv,
      });
    }
    runCli(smokeDir, projectDir, ["upgrade", "--check"]);

    if (shouldSmokeEject) {
      const currentBranch = run("git", ["branch", "--show-current"], {
        cwd: localUpstreamRepo,
      }).trim();
      run("node", ["scripts/eliza-source-mode.mjs", "local"], {
        cwd: projectDir,
        env: {
          ...fullstackInstallEnv,
          ELIZA_BRANCH: currentBranch || "develop",
          ELIZA_GIT_URL: localUpstreamRepo,
        },
      });
      assertPathExists(path.join(projectDir, "eliza", "package.json"));
      assertPathExists(path.join(projectDir, ".elizaos", "source-mode"));
    }

    passed = true;
    console.log("elizaos packaged smoke test passed");
  } finally {
    if (!shouldKeepTemp && passed) {
      fs.rmSync(tmpRoot, { force: true, recursive: true });
    } else if (!passed || shouldKeepTemp) {
      console.log(`elizaos packaged smoke temp dir: ${tmpRoot}`);
    }
  }
}

main();
