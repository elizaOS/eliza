import { IAgentRuntime, elizaLogger } from "@elizaos/core";
import { ClientBase } from "./base.ts";
import { DevaController } from "./controller";

export class DevaClient {
    private readonly runtime: IAgentRuntime;
    private readonly clientBase: ClientBase;
    private readonly controller: DevaController;

    constructor(runtime: IAgentRuntime, accessToken: string, baseUrl: string) {
        elizaLogger.log("📱 Constructing new DevaClient...");
        this.runtime = runtime;
        this.clientBase = new ClientBase(runtime, accessToken, baseUrl);
        this.controller = new DevaController(runtime, this.clientBase);
        elizaLogger.log("✅ DevaClient constructor completed");
    }

    public async start(): Promise<void> {
        elizaLogger.log("🚀 Starting DevaClient...");
        try {
            await this.controller.init();
            elizaLogger.log(
                "✨ DevaClient successfully launched and is running!"
            );
        } catch (error) {
            elizaLogger.error("❌ Failed to launch DevaClient:", error);
            throw error;
        }
    }
}
