import { injectable, unmanaged } from "inversify";
import type {
    IAgentRuntime,
    EvaluationExample,
    Memory,
    State,
    HandlerCallback,
} from "@elizaos/core";
import type { EvaluatorOptions, InjectableEvaluator } from "../types";

/**
 * Base abstract class for injectable actions
 */
@injectable()
export abstract class BaseInjectableEvaluator implements InjectableEvaluator {
    // -------- Properties --------
    public alwaysRun: boolean;
    public name: string;
    public similes: string[];
    public description: string;
    public examples: EvaluationExample[];

    /**
     * Constructor for the base injectable action
     */
    constructor(@unmanaged() opts: EvaluatorOptions) {
        // Set the action properties
        this.name = opts.name;
        this.similes = opts.similes;
        this.description = opts.description;
        this.examples = opts.examples;
        this.alwaysRun = opts.alwaysRun ?? false; // Default to false
    }

    /**
     * Default implementation of the validate method
     * You can override this method to add custom validation logic
     *
     * @param runtime The runtime object from Eliza framework
     * @param message The message object from Eliza framework
     * @param state The state object from Eliza framework
     * @returns The validation result
     */
    async validate(
        _runtime: IAgentRuntime,
        _message: Memory,
        _state?: State
    ): Promise<boolean> {
        // Default implementation is to return true
        return true;
    }

    /**
     * Handler for the evaluator
     */
    abstract handler(
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        options?: Record<string, unknown>,
        callback?: HandlerCallback
    ): Promise<unknown>;
}
