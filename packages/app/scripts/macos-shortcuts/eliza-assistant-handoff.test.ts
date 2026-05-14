import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const handoffScript = path.join(here, "eliza-assistant-handoff.sh");
const installScript = path.join(here, "install-eliza-shortcuts.sh");
const verifyScript = path.join(here, "verify-eliza-shortcuts.sh");

describe("macOS Shortcuts assistant handoff", () => {
  it("builds the assistant deep link used by the desktop runtime", async () => {
    const { stdout } = await execFileAsync("sh", [
      handoffScript,
      "--dry-run",
      "Remind me at 5 & call mom",
    ]);

    expect(stdout.trim()).toBe(
      "elizaos://assistant?text=Remind%20me%20at%205%20%26%20call%20mom&source=macos-shortcuts&action=ask",
    );
  });

  it("honors scheme, source, and action overrides", async () => {
    const { stdout } = await execFileAsync("sh", [
      handoffScript,
      "--dry-run",
      "--scheme",
      "milady",
      "--source",
      "macos-siri",
      "--action",
      "lifeops.create",
      "check in on me tomorrow morning",
    ]);

    expect(stdout.trim()).toBe(
      "milady://assistant?text=check%20in%20on%20me%20tomorrow%20morning&source=macos-siri&action=lifeops.create",
    );
  });

  it("accepts Shortcut input on stdin", async () => {
    const stdout = await runWithStdin(
      "sh",
      [handoffScript, "--dry-run"],
      "check in on me tomorrow morning",
      { ELIZA_SHORTCUT_ACTION: "lifeops.create" },
    );

    expect(stdout.trim()).toBe(
      "elizaos://assistant?text=check%20in%20on%20me%20tomorrow%20morning&source=macos-shortcuts&action=lifeops.create",
    );
  });

  it("installs the handoff and verifier scripts into the configured directory", async () => {
    const tempDir = path.join(
      await import("node:os").then((os) => os.tmpdir()),
      `eliza-shortcuts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    const { stdout } = await execFileAsync("sh", [installScript], {
      env: {
        ...process.env,
        ELIZA_SHORTCUT_INSTALL_DIR: tempDir,
      },
    });

    expect(stdout).toContain("Installed Eliza macOS Shortcuts handoff helper");
    expect(stdout).toContain("PASS helper builds assistant deep links");

    const { stdout: verifyStdout } = await execFileAsync("sh", [
      verifyScript,
      "--helper",
      path.join(tempDir, "eliza-assistant-handoff.sh"),
      "--no-shortcuts-warning",
    ]);

    expect(verifyStdout).toContain("PASS helper builds assistant deep links");
  });
});

function runWithStdin(
  command: string,
  args: string[],
  input: string,
  env: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr}`));
      }
    });
    child.stdin.end(input);
  });
}
