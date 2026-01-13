/**
 * Hook for saving and applying patches
 */

import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { AbstractRunHook } from './types';
import { ProblemStatementConfig } from '../../agent/problem-statement';
import { SWEEnv } from '../../environment/swe-env';
import { LocalRepo } from '../../environment/repo';
import { AgentRunResult, AgentInfo } from '../../types';
import { getLogger } from '../../utils/log';

const logger = getLogger('swea-save_apply_patch', '⚡️');

/**
 * Check if patch is promising (likely to solve the issue)
 */
function isPromisingPatch(info: AgentInfo): boolean {
  // The exit status can also be `submitted (exit_cost)` etc.
  return info.exitStatus === 'submitted' && info.submission !== null && info.submission !== undefined;
}

/**
 * Print patch message to console
 */
function printPatchMessage(patchOutputFile: string): void {
  console.log('\n🎉 Submission successful 🎉');
  console.log('SWE-agent has produced a patch that it believes will solve the issue you submitted!');
  console.log('Use the code snippet below to inspect or apply it!\n');

  console.log('```bash');
  console.log('# The patch has been saved to your local filesystem at:');
  console.log(`PATCH_FILE_PATH='${path.resolve(patchOutputFile)}'`);
  console.log('# Inspect it:');
  console.log('cat "${PATCH_FILE_PATH}"');
  console.log('# Apply it to a local repository:');
  console.log('cd <your local repo root>');
  console.log('git apply "${PATCH_FILE_PATH}"');
  console.log('```\n');
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

  constructor(applyPatchLocally: boolean = false, showSuccessMessage: boolean = true) {
    super();
    this.applyPatchLocally = applyPatchLocally;
    this.showSuccessMessage = showSuccessMessage;
  }

  onInit(run: { outputDir?: string }): void {
    this.outputDir = run.outputDir;
  }

  onInstanceStart(params: { index: number; env: SWEEnv; problemStatement: ProblemStatementConfig }): void {
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
      logger.info('No patch to save.');
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
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to apply patch ${patchFile} to ${localDir}: ${errorMessage}`);
    }
  }
}
