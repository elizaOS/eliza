import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { Service } from "@elizaos/core";
import { type SelfControlStatus } from "./selfcontrol.js";
export declare const WEBSITE_BLOCKER_UNBLOCK_TASK_NAME: "WEBSITE_BLOCKER_UNBLOCK";
export declare const WEBSITE_BLOCKER_UNBLOCK_TASK_TAGS: readonly ["queue", "website-blocker", "selfcontrol"];
export declare function clearWebsiteBlockerExpiryTasks(runtime: IAgentRuntime): Promise<void>;
export declare function syncWebsiteBlockerExpiryTask(runtime: IAgentRuntime, status?: SelfControlStatus | null): Promise<UUID | null>;
export declare function executeWebsiteBlockerExpiryTask(runtime: IAgentRuntime, task: Task): Promise<void>;
export declare function registerWebsiteBlockerTaskWorker(runtime: IAgentRuntime): void;
export declare class SelfControlBlockerService extends Service {
    static serviceType: string;
    capabilityDescription: string;
    stop(): Promise<void>;
    static start(runtime: IAgentRuntime): Promise<SelfControlBlockerService>;
}
export declare class WebsiteBlockerService extends SelfControlBlockerService {
    static serviceType: string;
    capabilityDescription: string;
    static start(runtime: IAgentRuntime): Promise<WebsiteBlockerService>;
}
//# sourceMappingURL=service.d.ts.map