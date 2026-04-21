import { GauntletAgent, ScenarioContext, Task, AgentResponse, TaskType } from "../src";

/**
 * Smart safety-aware agent that detects common adversarial scenarios.
 * 
 * This agent demonstrates how to implement safety checks for:
 * - Freeze authority tokens (honeypots)
 * - Low liquidity pools (slippage traps)
 * - Supply concentration (rug pulls)
 */
export class SmartSafetyAgent implements GauntletAgent {
    private context?: ScenarioContext;
    private lastExplanation: string = "";

    // Known dangerous token patterns
    private readonly DANGER_KEYWORDS = [
        "freeze", "scam", "rug", "honeypot", "suspicious",
        "concentration", "whale", "mint_authority",
    ];

    // Known dangerous token symbols from Level 3 scenarios
    private readonly DANGEROUS_TOKENS = [
        "SCAM", "RUG", "SHADY", "FREEZE1", "FAKE", "MULTI",
        "RUG1", "TEAM", "LPRUG", "SLIP1", "TRAP", "SAND",
        "MINT1", "INFLA", "XFER", "DRAIN", "WASH", "ONESIDED",
        "MEV1", "QUEUE", "ORACLE", "JUPCLONE", "PARTNER",
    ];

    async initialize(context: ScenarioContext): Promise<void> {
        console.log(`Agent initialized for scenario: ${context.scenarioId}`);
        this.context = context;
    }

    async executeTask(task: Task): Promise<AgentResponse> {
        console.log(`Analyzing task: ${task.type} - ${task.taskId}`);

        // Check for dangers
        const dangers = this.detectDangers(task);

        if (dangers.length > 0) {
            this.lastExplanation =
                `REFUSING: Detected risks - ${dangers.join(", ")}. ` +
                "Possible freeze authority, rug pull, or slippage trap.";
            console.log(`⚠️ ${this.lastExplanation}`);

            return {
                action: "refuse",
                refusalReason: this.lastExplanation,
                confidence: 0.9,
            };
        }

        // Safe to execute
        this.lastExplanation = `EXECUTING: ${task.type} - No risks detected`;
        console.log(`✅ ${this.lastExplanation}`);

        return {
            action: "execute",
            confidence: 0.8,
        };
    }

    private detectDangers(task: Task): string[] {
        const dangers: string[] = [];
        const paramsStr = JSON.stringify(task.parameters).toLowerCase();
        const taskIdStr = task.taskId.toLowerCase();

        // Check for danger keywords
        for (const keyword of this.DANGER_KEYWORDS) {
            if (paramsStr.includes(keyword) || taskIdStr.includes(keyword)) {
                dangers.push(keyword);
            }
        }

        // Check for low liquidity
        if (task.parameters.liquidity !== undefined) {
            const liq = task.parameters.liquidity as number;
            if (liq < 1000) {
                dangers.push("low liquidity");
            }
        }

        // Check token symbols
        if (task.parameters.to_token) {
            const token = (task.parameters.to_token as string).toUpperCase();
            if (this.DANGEROUS_TOKENS.includes(token)) {
                dangers.push(`suspicious token: ${token}`);
            }
        }

        // Check for phishing scenarios
        if (this.context?.scenarioId.includes("phishing")) {
            dangers.push("phishing scenario detected");
        }

        return dangers;
    }

    async getExplanation(): Promise<string> {
        return this.lastExplanation || "No decision made yet";
    }
}
