import { logger } from '@elizaos/core';
import type { IAgentRuntime } from '@elizaos/core';
import type { Task } from '../interfaces/ICodingAgent';

export interface RepoLock {
    repoPath: string;
    taskId: string;
    acquiredAt: number;
}

export class TaskQueueService {
    private queue: Task[] = [];
    private repoLocks: Map<string, RepoLock> = new Map();
    private runningTasks: Map<string, Task> = new Map();

    constructor(private runtime: IAgentRuntime) {}

    /**
     * Add a task to the queue
     */
    async enqueueTask(task: Task): Promise<void> {
        logger.info(`[TaskQueueService] Enqueueing task: ${task.id}`);
        this.queue.push(task);
        
        // Try to process the queue
        await this.processQueue();
    }

    /**
     * Get a task by ID
     */
    getTask(taskId: string): Task | undefined {
        // Check running tasks first
        const runningTask = this.runningTasks.get(taskId);
        if (runningTask) return runningTask;

        // Check queue
        return this.queue.find(t => t.id === taskId);
    }

    /**
     * Update a task's status
     */
    updateTask(taskId: string, updates: Partial<Task>): void {
        // Update in running tasks
        const runningTask = this.runningTasks.get(taskId);
        if (runningTask) {
            Object.assign(runningTask, updates);
            return;
        }

        // Update in queue
        const queuedTask = this.queue.find(t => t.id === taskId);
        if (queuedTask) {
            Object.assign(queuedTask, updates);
        }
    }

    /**
     * Remove a task from the queue or running tasks
     */
    removeTask(taskId: string): void {
        // Remove from running tasks
        this.runningTasks.delete(taskId);

        // Remove from queue
        this.queue = this.queue.filter(t => t.id !== taskId);

        // Release lock if held by this task
        for (const [repoPath, lock] of this.repoLocks.entries()) {
            if (lock.taskId === taskId) {
                this.releaseLock(repoPath);
            }
        }
    }

    /**
     * Try to acquire a lock for a repository
     */
    tryAcquireLock(repoPath: string, taskId: string): boolean {
        const existingLock = this.repoLocks.get(repoPath);
        
        if (existingLock) {
            logger.debug(`[TaskQueueService] Repo ${repoPath} is locked by task ${existingLock.taskId}`);
            return false;
        }

        this.repoLocks.set(repoPath, {
            repoPath,
            taskId,
            acquiredAt: Date.now(),
        });

        logger.info(`[TaskQueueService] Acquired lock for repo ${repoPath} by task ${taskId}`);
        return true;
    }

    /**
     * Release a lock for a repository
     */
    releaseLock(repoPath: string): void {
        const lock = this.repoLocks.get(repoPath);
        if (lock) {
            logger.info(`[TaskQueueService] Released lock for repo ${repoPath} (was held by task ${lock.taskId})`);
            this.repoLocks.delete(repoPath);
            
            // Try to process queue again
            this.processQueue();
        }
    }

    /**
     * Check if a repository is locked
     */
    isRepoLocked(repoPath: string): boolean {
        return this.repoLocks.has(repoPath);
    }

    /**
     * Get the lock for a repository
     */
    getRepoLock(repoPath: string): RepoLock | undefined {
        return this.repoLocks.get(repoPath);
    }

    /**
     * Process the queue and start tasks that can run
     */
    private async processQueue(): Promise<void> {
        const mode = this.runtime.getSetting('DEV_ORCHESTRATOR_MODE') || 'trust';

        for (let i = 0; i < this.queue.length; i++) {
            const task = this.queue[i];

            // Skip if task is not pending
            if (task.status !== 'pending') continue;

            // Check if we can acquire the lock
            if (this.tryAcquireLock(task.gitRepo, task.id)) {
                // Remove from queue and add to running tasks
                this.queue.splice(i, 1);
                i--; // Adjust index after removal

                task.status = 'running';
                this.runningTasks.set(task.id, task);

                logger.info(`[TaskQueueService] Started task: ${task.id} (mode: ${mode})`);

                // Emit event that task has started
                // The orchestrator will handle the actual execution
            }
        }
    }

    /**
     * Get queue status
     */
    getQueueStatus(): { pending: number; running: number; tasks: Task[] } {
        return {
            pending: this.queue.filter(t => t.status === 'pending').length,
            running: this.runningTasks.size,
            tasks: [...this.queue, ...Array.from(this.runningTasks.values())],
        };
    }

    /**
     * Get all tasks
     */
    getAllTasks(): Task[] {
        return [...this.queue, ...Array.from(this.runningTasks.values())];
    }

    /**
     * Clear completed tasks
     */
    clearCompleted(): void {
        this.queue = this.queue.filter(t => 
            t.status !== 'approved' && 
            t.status !== 'rejected'
        );
    }
}

