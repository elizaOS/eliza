export interface SnapshotInfo {
    stashId?: string;
    originalBranch: string;
    isDirty: boolean;
    timestamp: number;
}

export interface DiffInfo {
    files: string[];
    additions: number;
    deletions: number;
    diff: string;
}

export interface IVersionControl {
    /**
     * Create a snapshot of the current state (stash if dirty)
     */
    createSnapshot(repoPath: string, taskId: string): Promise<SnapshotInfo>;

    /**
     * Restore a snapshot (pop stash if exists)
     */
    restoreSnapshot(repoPath: string, snapshot: SnapshotInfo): Promise<void>;

    /**
     * Get the diff of current changes
     */
    getDiff(repoPath: string): Promise<DiffInfo>;

    /**
     * Commit changes with a message
     */
    commit(repoPath: string, message: string): Promise<void>;

    /**
     * Get the current branch name
     */
    getCurrentBranch(repoPath: string): Promise<string>;

    /**
     * Create and checkout a new branch
     */
    createBranch(repoPath: string, branchName: string): Promise<void>;

    /**
     * Checkout an existing branch
     */
    checkoutBranch(repoPath: string, branchName: string): Promise<void>;

    /**
     * Merge a branch into current branch
     */
    mergeBranch(repoPath: string, branchName: string): Promise<{ success: boolean; conflicts?: string[] }>;

    /**
     * Delete a branch
     */
    deleteBranch(repoPath: string, branchName: string): Promise<void>;

    /**
     * Get the git repository root path
     */
    getRepoRoot(path: string): Promise<string>;

    /**
     * Check if working directory is clean
     */
    isClean(repoPath: string): Promise<boolean>;
}

