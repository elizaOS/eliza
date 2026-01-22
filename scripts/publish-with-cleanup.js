#!/usr/bin/env node

/**
 * Publish packages with automatic cleanup on error.
 *
 * This script:
 * 1. Stashes any uncommitted changes (to satisfy lerna's git checks)
 * 2. Replaces workspace:* references with actual versions
 * 3. Runs lerna publish
 * 4. ALWAYS restores workspace:* references (success or failure)
 * 5. ALWAYS restores stashed changes
 *
 * Usage: node scripts/publish-with-cleanup.js <dist-tag>
 * Example: node scripts/publish-with-cleanup.js next
 */

import { execSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = dirname(__dirname);

const DIST_TAG = process.argv[2];
let stashCreated = false;
let tempCommitCreated = false;

if (!DIST_TAG) {
  console.error("❌ Error: dist-tag is required");
  console.error("Usage: node scripts/publish-with-cleanup.js <dist-tag>");
  console.error("Example: node scripts/publish-with-cleanup.js next");
  process.exit(1);
}

const validTags = ["latest", "next", "beta", "alpha"];
if (!validTags.includes(DIST_TAG)) {
  console.error(`❌ Error: Invalid dist-tag '${DIST_TAG}'`);
  console.error(`Valid tags: ${validTags.join(", ")}`);
  process.exit(1);
}

/**
 * Run a command and return a promise
 */
function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n$ ${command} ${args.join(" ")}\n`);

    const proc = spawn(command, args, {
      cwd: workspaceRoot,
      stdio: "inherit",
      shell: true,
      ...options,
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(code);
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Check if there are uncommitted changes
 */
function hasUncommittedChanges() {
  try {
    const status = execSync("git status --porcelain", {
      cwd: workspaceRoot,
      encoding: "utf-8",
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Stash uncommitted changes (excluding scripts/ directory)
 */
function stashChanges() {
  console.log("📦 Stashing uncommitted changes...");
  try {
    // Stash everything except the scripts directory (which contains this script)
    execSync(
      "git stash push -u -m 'publish-with-cleanup: temporary stash' -- . ':!scripts/'",
      {
        cwd: workspaceRoot,
        stdio: "inherit",
      },
    );
    stashCreated = true;
    console.log("✅ Changes stashed\n");
  } catch (err) {
    throw new Error(`Failed to stash changes: ${err.message}`);
  }
}

/**
 * Pop stashed changes
 */
function popStash() {
  if (!stashCreated) return;

  console.log("\n📦 Restoring stashed changes...");
  try {
    execSync("git stash pop", {
      cwd: workspaceRoot,
      stdio: "inherit",
    });
    stashCreated = false;
    console.log("✅ Stashed changes restored");
  } catch (_err) {
    console.error("⚠️ Warning: Failed to pop stash");
    console.error("   Run 'git stash pop' manually to restore your changes");
  }
}

/**
 * Create a temporary commit with package.json changes (for lerna's git checks)
 */
function createTempCommit() {
  console.log("📝 Creating temporary commit for publish...");
  try {
    // Stage only package.json files that were modified
    execSync("git add '**/package.json'", {
      cwd: workspaceRoot,
      stdio: "inherit",
    });

    // Create temporary commit
    execSync(
      "git commit -m 'temp: workspace version replacement for publish [skip ci]' --no-verify",
      {
        cwd: workspaceRoot,
        stdio: "inherit",
      },
    );

    tempCommitCreated = true;
    console.log("✅ Temporary commit created\n");
  } catch (err) {
    throw new Error(`Failed to create temporary commit: ${err.message}`);
  }
}

/**
 * Reset the temporary commit
 */
function resetTempCommit() {
  if (!tempCommitCreated) return;

  console.log("\n🔄 Resetting temporary commit...");
  try {
    execSync("git reset --soft HEAD~1", {
      cwd: workspaceRoot,
      stdio: "inherit",
    });
    tempCommitCreated = false;
    console.log("✅ Temporary commit reset");
  } catch (_err) {
    console.error("⚠️ Warning: Failed to reset temporary commit");
    console.error("   Run 'git reset --soft HEAD~1' manually if needed");
  }
}

/**
 * Restore workspace references
 */
async function restoreWorkspaceRefs() {
  console.log("\n🔄 Restoring workspace:* references...");
  try {
    await runCommand("node", [join(__dirname, "restore-workspace-refs.js")]);
    console.log("✅ Workspace references restored");
  } catch (_err) {
    console.error("⚠️ Warning: Failed to restore workspace references");
    console.error("   Run 'bun run postpublish:restore' manually if needed");
  }
}

/**
 * Main publish flow
 */
async function main() {
  let publishSucceeded = false;

  try {
    // Step 1: Check for uncommitted changes and stash them (excluding scripts/)
    if (hasUncommittedChanges()) {
      stashChanges();
    }

    // Step 2: Replace workspace:* with actual versions
    console.log("🔄 Replacing workspace:* references with actual versions...");
    await runCommand("node", [
      join(__dirname, "replace-workspace-versions.js"),
    ]);
    console.log("✅ Workspace references replaced\n");

    // Step 3: Create temporary commit (lerna requires clean git tree)
    createTempCommit();

    // Step 4: Run lerna publish
    console.log(`📦 Publishing packages with dist-tag: ${DIST_TAG}...`);
    await runCommand("bunx", [
      "lerna",
      "publish",
      "from-package",
      "--dist-tag",
      DIST_TAG,
      "--force-publish",
      "--yes",
      "--no-verify-access",
    ]);

    publishSucceeded = true;
    console.log(
      `\n✅ Successfully published packages with dist-tag: ${DIST_TAG}`,
    );
  } catch (err) {
    console.error(`\n❌ Publish failed: ${err.message}`);
  } finally {
    // Step 5: Reset the temporary commit (restores workspace:* in package.json)
    resetTempCommit();

    // Step 6: Restore workspace:* references (in case reset didn't fully restore)
    await restoreWorkspaceRefs();

    // Step 7: Unstage any remaining staged files
    try {
      execSync("git reset HEAD", { cwd: workspaceRoot, stdio: "pipe" });
    } catch {
      // Ignore if nothing to unstage
    }

    // Step 8: ALWAYS restore stashed changes
    popStash();
  }

  // Exit with appropriate code
  process.exit(publishSucceeded ? 0 : 1);
}

/**
 * Cleanup function for error handlers
 */
async function cleanup() {
  resetTempCommit();
  await restoreWorkspaceRefs();
  try {
    execSync("git reset HEAD", { cwd: workspaceRoot, stdio: "pipe" });
  } catch {
    // Ignore
  }
  popStash();
}

// Handle uncaught errors
process.on("uncaughtException", async (err) => {
  console.error(`\n❌ Uncaught exception: ${err.message}`);
  await cleanup();
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  console.error(`\n❌ Unhandled rejection: ${reason}`);
  await cleanup();
  process.exit(1);
});

// Handle interrupt signals
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, async () => {
    console.log(`\n\n⚠️ Received ${signal}, cleaning up...`);
    await cleanup();
    process.exit(130);
  });
}

main();
