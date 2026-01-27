/**
 * GitServiceAdapter - Wraps @elizaos/plugin-git's GitService
 *
 * ============================================================================
 * PREFERRED IMPLEMENTATION - Used when @elizaos/plugin-git is available
 * ============================================================================
 *
 * WHY THIS IS PREFERRED OVER GitServiceLegacy:
 * 1. BETTER TESTED - plugin-git is battle-tested and maintained separately
 * 2. SECURITY - plugin-git includes path validation and safety checks
 * 3. CONSISTENCY - Uses the same git implementation as other elizaOS plugins
 * 4. FEATURES - plugin-git may have optimizations not in our legacy impl
 *
 * WHY THE ADAPTER PATTERN:
 * plugin-git's GitService has a different API than our IVersionControl interface.
 * This adapter translates between them:
 *
 * | IVersionControl Method | plugin-git Equivalent                    |
 * |------------------------|------------------------------------------|
 * | createSnapshot()       | stash({ action: 'push' }) + branch info  |
 * | restoreSnapshot()      | checkout() + stash({ action: 'pop' })    |
 * | getDiff()              | getDiff() + custom stat parsing          |
 * | commit()               | add() + commit()                         |
 * | mergeBranch()          | merge({ noFf: true })                    |
 *
 * WHY IVersionControl INTERFACE:
 * Decouples the orchestrator from specific git implementations.
 * We can swap GitServiceAdapter for GitServiceLegacy (or future impls)
 * without changing orchestrator code.
 */

import { logger } from '@elizaos/core';
import type {
    IVersionControl,
    SnapshotInfo,
    DiffInfo,
} from '../interfaces/IVersionControl';

// Import plugin-git types and service
type GitService = {
    getCurrentBranch(repoPath: string): Promise<string | null>;
    getStatus(repoPath: string): Promise<{ isDirty: boolean; conflicted: string[] } | null>;
    stash(repoPath: string, options: {
        action: 'push' | 'pop' | 'apply' | 'list';
        message?: string;
        includeUntracked?: boolean;
        index?: number;
    }): Promise<{ success: boolean; error?: string; list?: string[] }>;
    checkout(repoPath: string, options: {
        branch: string;
        create?: boolean;
        force?: boolean;
    }): Promise<{ success: boolean; error?: string }>;
    commit(repoPath: string, options: {
        message: string;
        amend?: boolean;
        allowEmpty?: boolean;
    }): Promise<{ success: boolean; hash?: string; error?: string }>;
    add(repoPath: string, files?: string[], options?: { all?: boolean }): Promise<{ success: boolean; error?: string }>;
    merge(repoPath: string, options: {
        branch: string;
        noFf?: boolean;
        squash?: boolean;
        message?: string;
        abort?: boolean;
    }): Promise<{
        success: boolean;
        fastForward: boolean;
        hasConflicts: boolean;
        conflictedFiles: string[];
        error?: string;
    }>;
    deleteBranch(repoPath: string, branchName: string, options?: { force?: boolean }): Promise<{ success: boolean; error?: string }>;
    getDiff(repoPath: string, options?: {
        staged?: boolean;
        file?: string;
        stat?: boolean;
    }): Promise<{ success: boolean; diff?: string; error?: string }>;
};

/**
 * Execute a git command using Bun.spawn for getRepoRoot
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

export class GitServiceAdapter implements IVersionControl {
    constructor(private gitService: GitService) {}

    async createSnapshot(repoPath: string, taskId: string): Promise<SnapshotInfo> {
        const timestamp = Date.now();
        const originalBranch = await this.getCurrentBranch(repoPath);
        const isDirty = !(await this.isClean(repoPath));

        let stashId: string | undefined;

        if (isDirty) {
            const stashMessage = `elizaos-task-${taskId}-${timestamp}`;
            try {
                // Push stash with message
                const pushResult = await this.gitService.stash(repoPath, {
                    action: 'push',
                    message: stashMessage,
                    includeUntracked: true,
                });

                if (!pushResult.success) {
                    throw new Error(pushResult.error || 'Failed to create stash');
                }

                // Get the stash list to find our stash ID
                const listResult = await this.gitService.stash(repoPath, {
                    action: 'list',
                });

                if (listResult.success && listResult.list) {
                    const stashLine = listResult.list.find(line => line.includes(stashMessage));
                    if (stashLine) {
                        stashId = stashLine.split(':')[0].trim();
                    }
                }

                logger.info(`[GitServiceAdapter] Created stash: ${stashId}`);
            } catch (error) {
                logger.error('[GitServiceAdapter] Failed to create stash:', error);
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
                    // Extract stash index from stash@{N}
                    const indexMatch = snapshot.stashId.match(/stash@\{(\d+)\}/);
                    const index = indexMatch ? parseInt(indexMatch[1]) : 0;

                    const result = await this.gitService.stash(repoPath, {
                        action: 'pop',
                        index,
                    });

                    if (!result.success) {
                        throw new Error(result.error || 'Failed to pop stash');
                    }

                    logger.info(`[GitServiceAdapter] Restored stash: ${snapshot.stashId}`);
                } catch (error) {
                    // If pop fails, try apply instead
                    logger.warn('[GitServiceAdapter] Stash pop failed, trying apply:', error);

                    const indexMatch = snapshot.stashId.match(/stash@\{(\d+)\}/);
                    const index = indexMatch ? parseInt(indexMatch[1]) : 0;

                    const result = await this.gitService.stash(repoPath, {
                        action: 'apply',
                        index,
                    });

                    if (!result.success) {
                        throw new Error(result.error || 'Failed to apply stash');
                    }
                }
            }
        } catch (error) {
            logger.error('[GitServiceAdapter] Failed to restore snapshot:', error);
            throw new Error(`Failed to restore snapshot: ${error}`);
        }
    }

    async getDiff(repoPath: string): Promise<DiffInfo> {
        try {
            // Get full diff
            const diffResult = await this.gitService.getDiff(repoPath, {});
            if (!diffResult.success) {
                throw new Error(diffResult.error || 'Failed to get diff');
            }

            // Get file list
            const filesResult = await execGit(['diff', '--name-only', 'HEAD'], repoPath);
            const files = filesResult.stdout.trim().split('\n').filter(f => f);

            // Get stats
            const statResult = await this.gitService.getDiff(repoPath, { stat: true });
            let additions = 0;
            let deletions = 0;

            if (statResult.success && statResult.diff) {
                const statMatch = statResult.diff.match(/(\d+) insertion.*?(\d+) deletion/);
                additions = statMatch ? parseInt(statMatch[1]) : 0;
                deletions = statMatch ? parseInt(statMatch[2]) : 0;
            }

            return {
                files,
                additions,
                deletions,
                diff: diffResult.diff || '',
            };
        } catch (error) {
            logger.error('[GitServiceAdapter] Failed to get diff:', error);
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
            // Stage all files
            const addResult = await this.gitService.add(repoPath, undefined, { all: true });
            if (!addResult.success) {
                throw new Error(addResult.error || 'Failed to stage files');
            }

            // Create commit
            const commitResult = await this.gitService.commit(repoPath, { message });
            if (!commitResult.success) {
                throw new Error(commitResult.error || 'Failed to commit');
            }

            logger.info(`[GitServiceAdapter] Committed changes: ${message}`);
        } catch (error) {
            logger.error('[GitServiceAdapter] Failed to commit:', error);
            throw new Error(`Failed to commit: ${error}`);
        }
    }

    async getCurrentBranch(repoPath: string): Promise<string> {
        try {
            const branch = await this.gitService.getCurrentBranch(repoPath);
            if (!branch) {
                throw new Error('Failed to get current branch');
            }
            return branch;
        } catch (error) {
            logger.error('[GitServiceAdapter] Failed to get current branch:', error);
            throw new Error(`Failed to get current branch: ${error}`);
        }
    }

    async createBranch(repoPath: string, branchName: string): Promise<void> {
        try {
            const result = await this.gitService.checkout(repoPath, {
                branch: branchName,
                create: true,
            });

            if (!result.success) {
                throw new Error(result.error || 'Failed to create branch');
            }

            logger.info(`[GitServiceAdapter] Created and checked out branch: ${branchName}`);
        } catch (error) {
            logger.error('[GitServiceAdapter] Failed to create branch:', error);
            throw new Error(`Failed to create branch: ${error}`);
        }
    }

    async checkoutBranch(repoPath: string, branchName: string): Promise<void> {
        try {
            const result = await this.gitService.checkout(repoPath, {
                branch: branchName,
            });

            if (!result.success) {
                throw new Error(result.error || 'Failed to checkout branch');
            }

            logger.info(`[GitServiceAdapter] Checked out branch: ${branchName}`);
        } catch (error) {
            logger.error('[GitServiceAdapter] Failed to checkout branch:', error);
            throw new Error(`Failed to checkout branch: ${error}`);
        }
    }

    async mergeBranch(repoPath: string, branchName: string): Promise<{ success: boolean; conflicts?: string[] }> {
        try {
            const result = await this.gitService.merge(repoPath, {
                branch: branchName,
                noFf: true,
            });

            if (!result.success) {
                if (result.hasConflicts) {
                    logger.warn(`[GitServiceAdapter] Merge conflicts detected: ${result.conflictedFiles.join(', ')}`);
                    // Abort the merge
                    await this.gitService.merge(repoPath, {
                        branch: branchName,
                        abort: true,
                    });
                    return { success: false, conflicts: result.conflictedFiles };
                }
                throw new Error(result.error || 'Failed to merge branch');
            }

            logger.info(`[GitServiceAdapter] Merged branch: ${branchName}`);
            return { success: true };
        } catch (error) {
            logger.error('[GitServiceAdapter] Failed to merge branch:', error);
            throw new Error(`Failed to merge branch: ${error}`);
        }
    }

    async deleteBranch(repoPath: string, branchName: string): Promise<void> {
        try {
            const result = await this.gitService.deleteBranch(repoPath, branchName);
            if (!result.success) {
                throw new Error(result.error || 'Failed to delete branch');
            }
            logger.info(`[GitServiceAdapter] Deleted branch: ${branchName}`);
        } catch (error) {
            logger.error('[GitServiceAdapter] Failed to delete branch:', error);
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
            logger.error('[GitServiceAdapter] Failed to get repo root:', error);
            throw new Error(`Failed to get repo root: ${error}`);
        }
    }

    async isClean(repoPath: string): Promise<boolean> {
        try {
            const status = await this.gitService.getStatus(repoPath);
            if (!status) {
                return false;
            }
            return !status.isDirty;
        } catch (error) {
            logger.error('[GitServiceAdapter] Failed to check if clean:', error);
            return false;
        }
    }
}
