import type { Plugin, IAgentRuntime } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { DevOrchestratorService } from './services/orchestrator.service';
import { submitTaskAction, queueStatusAction } from './actions/submit-task';
import { approveTaskAction, rejectTaskAction } from './actions/review-task';
import { rollbackAction } from './actions/rollback';
import { setAgentPreferenceAction } from './actions/set-agent-preference';
import { printDevOrchestratorBanner } from './banner';

export const devOrchestratorPlugin: Plugin = {
    name: 'dev-orchestrator',
    description: 'Chat-driven development orchestration with AI coding agents, git safety, and build automation',
    
    services: [DevOrchestratorService],
    
    actions: [
        submitTaskAction,
        queueStatusAction,
        approveTaskAction,
        rejectTaskAction,
        rollbackAction,
        setAgentPreferenceAction,
    ],
    
    evaluators: [],
    providers: [],
    
    init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
        // Print beautiful settings banner
        printDevOrchestratorBanner(runtime);
    },
};

export default devOrchestratorPlugin;

// Export types and services
export { DevOrchestratorService } from './services/orchestrator.service';
export { GitServiceAdapter } from './services/git-adapter.service';
export { GitServiceLegacy } from './services/git-legacy.service';
export { BuildService } from './services/build.service';
export { CursorAgent } from './services/agents/cursor.agent';
export { ClaudeCodeAgent } from './services/agents/claude-code.agent';
export { TaskQueueService } from './services/task-queue.service';
export { CommandApprovalService } from './services/command-approval.service';
export { AgentRegistry, registerAgentWithDetection } from './services/agent-registry.service';

// Export action helpers
export { getUserAgentPreference } from './actions/set-agent-preference';

export type { Task, ICodingAgent, AgentResult } from './interfaces/ICodingAgent';
export type { IVersionControl, SnapshotInfo, DiffInfo } from './interfaces/IVersionControl';
export type { IBuildSystem, BuildResult } from './interfaces/IBuildSystem';
export type { AgentRegistration } from './services/agent-registry.service';

