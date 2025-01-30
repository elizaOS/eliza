import type {
    Action,
    Client,
    Evaluator,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    Plugin,
    Provider,
    Service,
    State,
} from "@elizaos/core";
import type { ContentClass } from "./decorators";
import type { z } from "zod";

// ----------- Interfaces for Injectable Providers and Actions, etc -----------

/**
 * Interface of Injectable Provider
 */
export interface InjectableProvider<T> extends Provider {
    /**
     * Get the instance of the provider related to Eliza runtime
     * @param runtime The runtime object from Eliza framework
     */
    getInstance(runtime: IAgentRuntime): Promise<T>;
}

/**
 * Action options
 */
export type ActionOptions<T> = Pick<
    Action,
    "name" | "similes" | "description" | "examples" | "suppressInitialMessage"
> & {
    contentClass: ContentClass<T>;
    template?: string;
    contentSchema?: z.ZodSchema<T>;
};

/**
 * Interface of Injectable Action
 */
export interface InjectableAction<T> extends Action {
    /**
     * Execute the action
     * @param content The content from processMessages
     * @param callback The callback function to pass the result to Eliza runtime
     */
    execute(
        content: T | null,
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        callback?: HandlerCallback
    ): Promise<any | null>;
}

/**
 * Evaluator options
 */
export type EvaluatorOptions = Pick<
    Evaluator,
    "name" | "similes" | "description" | "examples" | "alwaysRun"
>;

/**
 * Interface of Injectable Evaluator
 */
export type InjectableEvaluator = Evaluator;

/**
 * The Class of Injectable Object
 */
export type InjectableObjectClass<T, Args extends any[] = any[]> = new (
    ...args: Args
) => T;

/**
 * The Class of Injectable Provider
 */
export type InjectableProviderClass<T = any, Args extends any[] = any[]> = InjectableObjectClass<InjectableProvider<T> | Provider, Args>

/**
 * The Class of Injectable Action
 */
export type InjectableActionClass<T = any, Args extends any[] = any[]> = InjectableObjectClass<InjectableAction<T> | Action, Args>

/**
 * The Class of Injectable Evaluator
 */
export type InjectableEvaluatorClass<Args extends any[] = any[]> = InjectableObjectClass<InjectableEvaluator | Evaluator, Args>

/**
 * The Class of Injectable Service
 */
export type InjectableServiceClass<Args extends any[] = any[]> = InjectableObjectClass<Service, Args>;

/**
 * The Class of Injectable Client
 */
export type InjectableClientClass<Args extends any[] = any[]> = InjectableObjectClass<Client, Args>;

// ----------- Interfaces for Plugin -----------

/**
 * Plugin options
 */
export type PluginOptions = Pick<
    Plugin,
    "name" | "description"
> & {
    /** Optional actions */
    actions?: (Action | InjectableActionClass)[];
    /** Optional providers */
    providers?: (Provider | InjectableProviderClass)[];
    /** Optional evaluators */
    evaluators?: (Evaluator | InjectableEvaluatorClass)[];
    /** Optional services */
    services?: (Service | InjectableServiceClass)[];
    /** Optional clients */
    clients?: (Client | InjectableClientClass)[];
};

/**
 * Factory type for creating a plugin
 */
export type PluginFactory = (opts: PluginOptions) => Promise<Plugin>;

// ----------- Interfaces for Content Properties or actions -----------

export interface ContentPropertyDescription {
    description: string;
    examples?: string[];
}
