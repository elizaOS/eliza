import { logger, Service } from '@elizaos/core';
import type { IAgentRuntime } from '@elizaos/core';
import type { Task, ICodingAgent, AgentResult } from '../interfaces/ICodingAgent';
import type { IVersionControl } from '../interfaces/IVersionControl';
import { GitServiceAdapter } from './git-adapter.service';
import { GitServiceLegacy } from './git-legacy.service';
import { BuildService } from './build.service';
import { CursorAgent } from './agents/cursor.agent';
import { ClaudeCodeAgent } from './agents/claude-code.agent';
import { TaskQueueService } from './task-queue.service';
import { CommandApprovalService } from './command-approval.service';
import { AgentRegistry, registerAgentWithDetection } from './agent-registry.service';
import type { SnapshotInfo } from '../interfaces/IVersionControl';

export class DevOrchestratorService extends Service {
    static serviceType: string = 'DEV_ORCHESTRATOR';
    capabilityDescription: string = 'Chat-driven development orchestration with AI coding agents';

    private gitService!: IVersionControl;
    private buildService!: BuildService;
    private taskQueue!: TaskQueueService;
    private commandApproval!: CommandApprovalService;
    private agentRegistry: AgentRegistry;

    static async start(runtime: IAgentRuntime): Promise<DevOrchestratorService> {
        const service = new DevOrchestratorService(runtime);

        // Try to use plugin-git service if available (preferred)
        try {
            const pluginGitService = runtime.getService('git');
            if (pluginGitService) {
                service.gitService = new GitServiceAdapter(pluginGitService as any);
                logger.info('[DevOrchestratorService] Using plugin-git service');
            } else {
                service.gitService = new GitServiceLegacy();
                logger.info('[DevOrchestratorService] Using legacy git service (plugin-git not available)');
            }
        } catch (error) {
            service.gitService = new GitServiceLegacy();
            logger.info('[DevOrchestratorService] Using legacy git service (fallback)');
        }

        service.buildService = new BuildService();
        service.taskQueue = new TaskQueueService(runtime);
        service.commandApproval = new CommandApprovalService(runtime);

        // Get agent registry singleton
        service.agentRegistry = AgentRegistry.getInstance();

        // Register available coding agents with CLI detection
        await registerAgentWithDetection(
            'claude-code',
            new ClaudeCodeAgent(),
            'claude',
            {
                displayName: 'Claude Code',
                isRecommended: true,
                isStable: true,
                description: 'AI coding assistant with superior code understanding',
                aliases: ['claude', 'claude-code', 'claudecode'],
            }
        );

        await registerAgentWithDetection(
            'cursor',
            new CursorAgent(),
            'cursor',
            {
                displayName: 'Cursor',
                isRecommended: false,
                isStable: false, // Marked experimental until CLI verified
                description: 'IDE-integrated AI coding assistant',
                aliases: ['cursor', 'cursor-ai'],
            }
        );

        const status = service.agentRegistry.getStatus();
        logger.info(
            `[DevOrchestratorService] Agent registry: ${status.available}/${status.total} available, recommended: ${status.recommended || 'none'}`
        );

        return service;
    }

    async initialize(runtime: IAgentRuntime): Promise<void> {
        this.runtime = runtime;

        // Try to use plugin-git service if available (preferred)
        try {
            const pluginGitService = runtime.getService('git');
            if (pluginGitService) {
                this.gitService = new GitServiceAdapter(pluginGitService as any);
                logger.info('[DevOrchestratorService] Using plugin-git service');
            } else {
                this.gitService = new GitServiceLegacy();
                logger.info('[DevOrchestratorService] Using legacy git service (plugin-git not available)');
            }
        } catch (error) {
            this.gitService = new GitServiceLegacy();
            logger.info('[DevOrchestratorService] Using legacy git service (fallback)');
        }

        this.buildService = new BuildService();
        this.taskQueue = new TaskQueueService(runtime);
        this.commandApproval = new CommandApprovalService(runtime);

        // Get agent registry singleton
        this.agentRegistry = AgentRegistry.getInstance();

        // Register available coding agents with CLI detection
        await registerAgentWithDetection(
            'claude-code',
            new ClaudeCodeAgent(),
            'claude',
            {
                displayName: 'Claude Code',
                isRecommended: true,
                isStable: true,
                description: 'AI coding assistant with superior code understanding',
                aliases: ['claude', 'claude-code', 'claudecode'],
            }
        );

        await registerAgentWithDetection(
            'cursor',
            new CursorAgent(),
            'cursor',
            {
                displayName: 'Cursor',
                isRecommended: false,
                isStable: false,
                description: 'IDE-integrated AI coding assistant',
                aliases: ['cursor', 'cursor-ai'],
            }
        );

        const status = this.agentRegistry.getStatus();
        logger.info(
            `[DevOrchestratorService] Agent registry: ${status.available}/${status.total} available, recommended: ${status.recommended || 'none'}`
        );
    }

    async stop(): Promise<void> {
        // Cleanup resources
        logger.info('[DevOrchestratorService] Stopping service');
    }

    /**
     * Submit a new coding task
     */
    async submitTask(
        projectPath: string,
        prompt: string,
        agentType: string = 'claude-code'
    ): Promise<Task> {
        // Validate agent type
        if (!this.agentRegistry.has(agentType)) {
            const availableAgents = this.agentRegistry.getSortedNames().join(', ');
            throw new Error(`Unknown agent type: ${agentType}. Available agents: ${availableAgents}`);
        }

        // Check if agent is actually available (CLI detected)
        if (!this.agentRegistry.isAvailable(agentType)) {
            const registration = this.agentRegistry.get(agentType);
            throw new Error(
                `Agent '${agentType}' is registered but not available. ` +
                `CLI '${registration?.cliCommand}' not found in PATH.`
            );
        }

        // Get git repo root
        const gitRepo = await this.gitService.getRepoRoot(projectPath);

        // Create task
        const task: Task = {
            id: `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            status: 'pending',
            projectPath,
            gitRepo,
            prompt,
            agentType,
            createdAt: new Date(),
            buildAttempts: 0,
        };

        logger.info(`[DevOrchestratorService] Submitted task: ${task.id} with agent: ${agentType}`);

        // Add to queue
        await this.taskQueue.enqueueTask(task);

        // Start execution if lock is available
        await this.executeNextTask();

        return task;
    }

    /**
     * Execute the next available task
     */
    private async executeNextTask(): Promise<void> {
        const status = this.taskQueue.getQueueStatus();
        const runningTask = status.tasks.find(t => t.status === 'running');

        if (!runningTask) return;

        try {
            await this.executeTask(runningTask);
        } catch (error) {
            logger.error('[DevOrchestratorService] Task execution failed:', error);
            this.taskQueue.updateTask(runningTask.id, {
                status: 'needs_manual_resolution',
                error: error instanceof Error ? error.message : String(error),
            });
            this.taskQueue.releaseLock(runningTask.gitRepo);
        }
    }

    /**
     * Execute a task through the full workflow
     */
    private async executeTask(task: Task): Promise<void> {
        const mode = this.runtime.getSetting('DEV_ORCHESTRATOR_MODE') || 'trust';
        logger.info(`[DevOrchestratorService] Executing task ${task.id} in ${mode} mode`);

        let snapshot: SnapshotInfo | null = null;

        try {
            // 1. Create snapshot
            snapshot = await this.gitService.createSnapshot(task.projectPath, task.id);
            logger.info(`[DevOrchestratorService] Created snapshot for task ${task.id}`);

            // 2. If isolated mode, create branch
            if (mode === 'isolated') {
                const branchName = `feat/task-${task.id}`;
                await this.gitService.createBranch(task.projectPath, branchName);
                task.branch = branchName;
                logger.info(`[DevOrchestratorService] Created branch: ${branchName}`);
            }

            // 3. Execute agent
            const agentType = task.agentType || 'claude-code'; // Default to claude-code
            const agent = this.agentRegistry.getAgent(agentType);
            if (!agent) {
                const availableAgents = this.agentRegistry.getSortedNames().join(', ');
                throw new Error(`Agent '${agentType}' not found. Available agents: ${availableAgents}`);
            }
            logger.info(`[DevOrchestratorService] Using agent: ${agentType}`);

            let result = await agent.execute(task, this.runtime);

            // 4. Build verification with retry
            const maxBuildAttempts = 3;
            while (!result.success && (task.buildAttempts || 0) < maxBuildAttempts) {
                task.buildAttempts = (task.buildAttempts || 0) + 1;
                logger.warn(`[DevOrchestratorService] Build attempt ${task.buildAttempts} failed, retrying...`);

                // Try to fix the error
                result = await agent.fixError(result.error || 'Unknown error', task, this.runtime);
            }

            if (!result.success) {
                throw new Error(`Build failed after ${maxBuildAttempts} attempts: ${result.error}`);
            }

            // 5. Run build
            const buildCmdSetting = this.runtime.getSetting('DEV_ORCHESTRATOR_BUILD_CMD');
            const buildCmd = typeof buildCmdSetting === 'string' ? buildCmdSetting : undefined;
            const buildResult = await this.buildService.build(task.projectPath, buildCmd);

            if (!buildResult.success) {
                // Try to fix build error
                logger.warn('[DevOrchestratorService] Build failed, attempting to fix...');
                const fixResult = await agent.fixError(buildResult.error || buildResult.output, task, this.runtime);

                if (fixResult.success) {
                    // Retry build
                    const retryBuildResult = await this.buildService.build(task.projectPath, buildCmd);
                    if (!retryBuildResult.success) {
                        throw new Error(`Build failed: ${retryBuildResult.error}`);
                    }
                } else {
                    throw new Error(`Build failed and fix attempt failed: ${buildResult.error}`);
                }
            }

            // 6. Commit changes
            await this.gitService.commit(task.projectPath, `task: ${task.prompt}`);

            // 7. If isolated mode, merge back
            if (mode === 'isolated' && task.branch) {
                await this.gitService.checkoutBranch(task.projectPath, snapshot.originalBranch);
                const mergeResult = await this.gitService.mergeBranch(task.projectPath, task.branch);

                if (!mergeResult.success) {
                    logger.error(`[DevOrchestratorService] Merge conflicts detected: ${mergeResult.conflicts?.join(', ')}`);
                    this.taskQueue.updateTask(task.id, {
                        status: 'needs_manual_resolution',
                        error: `Merge conflicts in files: ${mergeResult.conflicts?.join(', ')}`,
                    });
                    return;
                }

                // Delete the branch
                await this.gitService.deleteBranch(task.projectPath, task.branch);
            }

            // 8. Restore stash if exists
            if (snapshot) {
                await this.gitService.restoreSnapshot(task.projectPath, snapshot);
            }

            // 9. Get diff for review
            const diff = await this.gitService.getDiff(task.projectPath);
            task.modifiedFiles = diff.files;

            // 10. Mark as ready for review
            this.taskQueue.updateTask(task.id, {
                status: 'review',
                modifiedFiles: diff.files,
            });

            logger.info(`[DevOrchestratorService] Task ${task.id} completed, awaiting review`);

            // TODO: Emit event for completion via proper callback mechanism
            logger.info(`[DevOrchestratorService] Task completed: ${diff.files.length} files modified`);
        } catch (error) {
            logger.error(`[DevOrchestratorService] Task ${task.id} failed:`, error);

            // Restore snapshot on error
            if (snapshot) {
                try {
                    await this.gitService.restoreSnapshot(task.projectPath, snapshot);
                } catch (restoreError) {
                    logger.error('[DevOrchestratorService] Failed to restore snapshot:', restoreError);
                }
            }

            this.taskQueue.updateTask(task.id, {
                status: 'needs_manual_resolution',
                error: error instanceof Error ? error.message : String(error),
            });

            throw error;
        } finally {
            // Release lock
            this.taskQueue.releaseLock(task.gitRepo);
        }
    }

    /**
     * Approve a task
     */
    async approveTask(taskId: string): Promise<void> {
        const task = this.taskQueue.getTask(taskId);
        if (!task) {
            throw new Error(`Task ${taskId} not found`);
        }

        if (task.status !== 'review') {
            throw new Error(`Task ${taskId} is not in review status`);
        }

        this.taskQueue.updateTask(taskId, { status: 'approved' });
        logger.info(`[DevOrchestratorService] Task ${taskId} approved`);

        // TODO: Emit event for task completion via proper event system
        logger.info(`[DevOrchestratorService] Task approved: ${task.projectPath}`);
    }

    /**
     * Reject a task
     */
    async rejectTask(taskId: string, reason?: string): Promise<void> {
        const task = this.taskQueue.getTask(taskId);
        if (!task) {
            throw new Error(`Task ${taskId} not found`);
        }

        if (task.status !== 'review') {
            throw new Error(`Task ${taskId} is not in review status`);
        }

        // Rollback changes
        await this.gitService.checkoutBranch(task.projectPath, 'HEAD');

        this.taskQueue.updateTask(taskId, {
            status: 'rejected',
            error: reason,
        });

        logger.info(`[DevOrchestratorService] Task ${taskId} rejected: ${reason}`);
    }

    /**
     * Get task queue status
     */
    getQueueStatus() {
        return this.taskQueue.getQueueStatus();
    }

    /**
     * Get a specific task
     */
    getTask(taskId: string): Task | undefined {
        return this.taskQueue.getTask(taskId);
    }
}

