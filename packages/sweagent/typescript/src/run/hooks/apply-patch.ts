/**
 * Hook for saving and applying patches
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ProblemStatementConfig } from "../../agent/problem-statement";
import { LocalRepo } from "../../environment/repo";
import type { SWEEnv } from "../../environment/swe-env";
import type { AgentInfo, AgentRunResult } from "../../types";
import { getLogger } from "../../utils/log";
import { AbstractRunHook } from "./types";

const logger = getLogger("swea-save_apply_patch", "⚡️");

/**
 * Check if patch is promising (likely to solve the issue)
 */
function isPromisingPatch(info: AgentInfo): boolean {
  // The exit status can also be `submitted (exit_cost)` etc.
  return (
    info.exitStatus === "submitted" &&
    info.submission !== null &&
    info.submission !== undefined
  );
}

/**
 * Print patch message to console
 */
function printPatchMessage(patchOutputFile: string): void {
  console.log("\n🎉 Submission successful 🎉");
  console.log(
    "SWE-agent has produced a patch that it believes will solve the issue you submitted!",
  );
  console.log("Use the code snippet below to inspect or apply it!\n");

  const patchPath = path.resolve(patchOutputFile);
  const bashCommands = [
    "```bash",
    "# The patch has been saved to your local filesystem at:",
    `PATCH_FILE_PATH='${patchPath}'`,
    "# Inspect it:",
    "cat $PATCH_FILE_PATH",
    "# Apply it to a local repository:",
    "cd <your local repo root>",
    "git apply $PATCH_FILE_PATH",
    "```\n",
  ];
  for (const line of bashCommands) {
    console.log(line);
  }
}

/**
 * This hook saves patches to a separate directory and optionally applies them to a local repository
 */
export class SaveApplyPatchHook extends AbstractRunHook {
  private applyPatchLocally: boolean;
  private showSuccessMessage: boolean;
  private outputDir?: string;
  private env?: SWEEnv;
  private problemStatement?: ProblemStatementConfig;

  constructor(
    applyPatchLocally: boolean = false,
    showSuccessMessage: boolean = true,
  ) {
    super();
    this.applyPatchLocally = applyPatchLocally;
    this.showSuccessMessage = showSuccessMessage;
  }

  onInit(run: { outputDir?: string }): void {
    this.outputDir = run.outputDir;
  }

  onInstanceStart(params: {
    index: number;
    env: SWEEnv;
    problemStatement: ProblemStatementConfig;
  }): void {
    this.env = params.env;
    this.problemStatement = params.problemStatement;
  }

  onInstanceCompleted(params: { result: AgentRunResult }): void {
    const instanceId = this.problemStatement?.id;
    if (!instanceId) {
      return;
    }

    const patchPath = this.savePatch(instanceId, params.result.info);

    if (!patchPath) {
      return;
    }

    if (!this.applyPatchLocally) {
      return;
    }

    if (!isPromisingPatch(params.result.info)) {
      return;
    }

    if (!this.env?.repo) {
      return;
    }

    if (!(this.env.repo instanceof LocalRepo)) {
      return;
    }

    const localDir = this.env.repo.path;
    this.applyPatch(patchPath, localDir);
  }

  /**
   * Create patch files that can be applied with `git am`.
   * Returns the path to the patch file if it was saved, otherwise null.
   */
  private savePatch(instanceId: string, info: AgentInfo): string | null {
    if (!this.outputDir) {
      return null;
    }

    const patchOutputDir = path.join(this.outputDir, instanceId);

    // Create directory if it doesn't exist
    if (!fs.existsSync(patchOutputDir)) {
      fs.mkdirSync(patchOutputDir, { recursive: true });
    }

    const patchOutputFile = path.join(patchOutputDir, `${instanceId}.patch`);

    if (!info.submission) {
      logger.info("No patch to save.");
      return null;
    }

    const modelPatch = info.submission;
    fs.writeFileSync(patchOutputFile, modelPatch);

    if (isPromisingPatch(info)) {
      // Only print big congratulations if we actually believe
      // the patch will solve the issue
      if (this.showSuccessMessage) {
        printPatchMessage(patchOutputFile);
      }
    }

    return patchOutputFile;
  }

  /**
   * Apply a patch to a local directory
   */
  private applyPatch(patchFile: string, localDir: string): void {
    if (!fs.existsSync(localDir) || !fs.statSync(localDir).isDirectory()) {
      logger.error(`Local directory does not exist: ${localDir}`);
      return;
    }

    if (!fs.existsSync(patchFile)) {
      logger.error(`Patch file does not exist: ${patchFile}`);
      return;
    }

    // The resolve() is important, because we're gonna run the cmd
    // somewhere else
    const cmd = `git apply "${path.resolve(patchFile)}"`;

    try {
      execSync(cmd, { cwd: localDir });
      logger.info(`Applied patch ${patchFile} to ${localDir}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        `Failed to apply patch ${patchFile} to ${localDir}: ${errorMessage}`,
      );
    }
  }
}
