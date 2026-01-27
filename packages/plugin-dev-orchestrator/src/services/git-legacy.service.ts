/**
 * GitServiceLegacy - Standalone git service implementation using Bun.spawn
 *
 * ============================================================================
 * FALLBACK IMPLEMENTATION - Used when @elizaos/plugin-git is not available
 * ============================================================================
 *
 * WHY THIS EXISTS (DUAL IMPLEMENTATION PATTERN):
 * The dev-orchestrator needs git operations (stash, branch, commit, merge).
 * We support two implementations:
 *
 * 1. GitServiceAdapter (PREFERRED) - Wraps @elizaos/plugin-git when available
 *    - Better tested, maintained separately
 *    - Enhanced security with path validation
 *
 * 2. GitServiceLegacy (THIS FILE) - Standalone fallback
 *    - No external dependencies
 *    - Ensures dev-orchestrator works even without plugin-git installed
 *    - Uses Bun.spawn directly for all git operations
 *
 * WHY NOT JUST REQUIRE plugin-git:
 * - Users may want to use dev-orchestrator without adding plugin-git
 * - Reduces mandatory dependencies
 * - Plugin-git might not be installed in all environments
 *
 * HOW SELECTION WORKS:
 * At runtime, DevOrchestratorService checks if plugin-git is available:
 * - If yes: Uses GitServiceAdapter
 * - If no: Falls back to GitServiceLegacy
 * Both implement IVersionControl, so the orchestrator doesn't care which is used.
 *
 * WHY Bun.spawn:
 * Per elizaOS guidelines, we must use Bun.spawn instead of Node.js child_process.
 */

import { logger } from '@elizaos/core';
import type {
    IVersionControl,
    SnapshotInfo,
    DiffInfo,
} from '../interfaces/IVersionControl';

/**
 * Execute a git command using Bun.spawn
 */
async function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(['git', ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
    });

    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    return { stdout, stderr, exitCode };
}

export class GitServiceLegacy implements IVersionControl {
    async createSnapshot(repoPath: string, taskId: string): Promise<SnapshotInfo> {
        const timestamp = Date.now();
        const originalBranch = await this.getCurrentBranch(repoPath);
        const isDirty = !(await this.isClean(repoPath));

        let stashId: string | undefined;

        if (isDirty) {
            const stashMessage = `elizaos-task-${taskId}-${timestamp}`;
            try {
                await execGit(['stash', 'push', '-m', stashMessage], repoPath);

                // Get the stash ID (stash@{0})
                const { stdout } = await execGit(['stash', 'list'], repoPath);
                const stashLine = stdout.split('\n').find(line => line.includes(stashMessage));
                if (stashLine) {
                    stashId = stashLine.split(':')[0].trim();
                }
                logger.info(`[GitServiceLegacy] Created stash: ${stashId}`);
            } catch (error) {
                logger.error('[GitServiceLegacy] Failed to create stash:', error);
                throw new Error(`Failed to stash changes: ${error}`);
            }
        }

        return {
            stashId,
            originalBranch,
            isDirty,
            timestamp,
        };
    }

    async restoreSnapshot(repoPath: string, snapshot: SnapshotInfo): Promise<void> {
        try {
            // First, checkout the original branch
            await this.checkoutBranch(repoPath, snapshot.originalBranch);

            // Then restore the stash if it exists
            if (snapshot.stashId) {
                try {
                    const result = await execGit(['stash', 'pop', snapshot.stashId], repoPath);
                    if (result.exitCode !== 0) {
                        throw new Error(result.stderr);
                    }
                    logger.info(`[GitServiceLegacy] Restored stash: ${snapshot.stashId}`);
                } catch (error) {
                    // If pop fails, try apply instead
                    logger.warn('[GitServiceLegacy] Stash pop failed, trying apply:', error);
                    const result = await execGit(['stash', 'apply', snapshot.stashId], repoPath);
                    if (result.exitCode !== 0) {
                        throw new Error(result.stderr);
                    }
                }
            }
        } catch (error) {
            logger.error('[GitServiceLegacy] Failed to restore snapshot:', error);
            throw new Error(`Failed to restore snapshot: ${error}`);
        }
    }

    async getDiff(repoPath: string): Promise<DiffInfo> {
        try {
            const diffResult = await execGit(['diff', 'HEAD'], repoPath);
            const filesResult = await execGit(['diff', '--name-only', 'HEAD'], repoPath);
            const files = filesResult.stdout.trim().split('\n').filter(f => f);

            // Count additions and deletions
            const statResult = await execGit(['diff', '--stat', 'HEAD'], repoPath);
            const statMatch = statResult.stdout.match(/(\d+) insertion.*?(\d+) deletion/);
            const additions = statMatch ? parseInt(statMatch[1]) : 0;
            const deletions = statMatch ? parseInt(statMatch[2]) : 0;

            return {
                files,
                additions,
                deletions,
                diff: diffResult.stdout,
            };
        } catch (error) {
            logger.error('[GitServiceLegacy] Failed to get diff:', error);
            return {
                files: [],
                additions: 0,
                deletions: 0,
                diff: '',
            };
        }
    }

    async commit(repoPath: string, message: string): Promise<void> {
        try {
            const addResult = await execGit(['add', '.'], repoPath);
            if (addResult.exitCode !== 0) {
                throw new Error(addResult.stderr);
            }

            const commitResult = await execGit(['commit', '-m', message], repoPath);
            if (commitResult.exitCode !== 0) {
                throw new Error(commitResult.stderr);
            }

            logger.info(`[GitServiceLegacy] Committed changes: ${message}`);
        } catch (error) {
            logger.error('[GitServiceLegacy] Failed to commit:', error);
            throw new Error(`Failed to commit: ${error}`);
        }
    }

    async getCurrentBranch(repoPath: string): Promise<string> {
        try {
            const result = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
            if (result.exitCode !== 0) {
                throw new Error(result.stderr);
            }
            return result.stdout.trim();
        } catch (error) {
            logger.error('[GitServiceLegacy] Failed to get current branch:', error);
            throw new Error(`Failed to get current branch: ${error}`);
        }
    }

    async createBranch(repoPath: string, branchName: string): Promise<void> {
        try {
            const result = await execGit(['checkout', '-b', branchName], repoPath);
            if (result.exitCode !== 0) {
                throw new Error(result.stderr);
            }
            logger.info(`[GitServiceLegacy] Created and checked out branch: ${branchName}`);
        } catch (error) {
            logger.error('[GitServiceLegacy] Failed to create branch:', error);
            throw new Error(`Failed to create branch: ${error}`);
        }
    }

    async checkoutBranch(repoPath: string, branchName: string): Promise<void> {
        try {
            const result = await execGit(['checkout', branchName], repoPath);
            if (result.exitCode !== 0) {
                throw new Error(result.stderr);
            }
            logger.info(`[GitServiceLegacy] Checked out branch: ${branchName}`);
        } catch (error) {
            logger.error('[GitServiceLegacy] Failed to checkout branch:', error);
            throw new Error(`Failed to checkout branch: ${error}`);
        }
    }

    async mergeBranch(repoPath: string, branchName: string): Promise<{ success: boolean; conflicts?: string[] }> {
        try {
            const result = await execGit(['merge', branchName, '--no-ff'], repoPath);
            if (result.exitCode !== 0) {
                throw new Error(result.stderr);
            }
            logger.info(`[GitServiceLegacy] Merged branch: ${branchName}`);
            return { success: true };
        } catch (error) {
            // Check if it's a merge conflict
            try {
                const result = await execGit(['diff', '--name-only', '--diff-filter=U'], repoPath);
                const conflicts = result.stdout.trim().split('\n').filter(f => f);
                if (conflicts.length > 0) {
                    logger.warn(`[GitServiceLegacy] Merge conflicts detected: ${conflicts.join(', ')}`);
                    // Abort the merge
                    await execGit(['merge', '--abort'], repoPath);
                    return { success: false, conflicts };
                }
            } catch (diffError) {
                logger.error('[GitServiceLegacy] Failed to check for conflicts:', diffError);
            }
            logger.error('[GitServiceLegacy] Failed to merge branch:', error);
            throw new Error(`Failed to merge branch: ${error}`);
        }
    }

    async deleteBranch(repoPath: string, branchName: string): Promise<void> {
        try {
            const result = await execGit(['branch', '-d', branchName], repoPath);
            if (result.exitCode !== 0) {
                throw new Error(result.stderr);
            }
            logger.info(`[GitServiceLegacy] Deleted branch: ${branchName}`);
        } catch (error) {
            logger.error('[GitServiceLegacy] Failed to delete branch:', error);
            throw new Error(`Failed to delete branch: ${error}`);
        }
    }

    async getRepoRoot(path: string): Promise<string> {
        try {
            const result = await execGit(['rev-parse', '--show-toplevel'], path);
            if (result.exitCode !== 0) {
                throw new Error(result.stderr);
            }
            return result.stdout.trim();
        } catch (error) {
            logger.error('[GitServiceLegacy] Failed to get repo root:', error);
            throw new Error(`Failed to get repo root: ${error}`);
        }
    }

    async isClean(repoPath: string): Promise<boolean> {
        try {
            const result = await execGit(['status', '--porcelain'], repoPath);
            return result.stdout.trim() === '';
        } catch (error) {
            logger.error('[GitServiceLegacy] Failed to check if clean:', error);
            return false;
        }
    }
}
