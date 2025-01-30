import { injectable, unmanaged } from "inversify";
import type { z } from "zod";
import {
    type ActionExample,
    composeContext,
    elizaLogger,
    generateObject,
    type HandlerCallback,
    type IAgentRuntime,
    type Memory,
    ModelClass,
    type State,
} from "@elizaos/core";
import {
    type ContentClass,
    createZodSchema,
    loadPropertyDescriptions,
} from "../decorators";
import type { ActionOptions, InjectableAction } from "../types";
import { buildContentOutputTemplate } from "../templates";

/**
 * Base abstract class for injectable actions
 */
@injectable()
export abstract class BaseInjectableAction<T> implements InjectableAction<T> {
    // -------- Properties --------
    public name: string;
    public similes: string[];
    public description: string;
    public examples: ActionExample[][];
    public suppressInitialMessage: boolean;

    /**
     * The content class for the action
     */
    protected readonly contentClass: ContentClass<T>;
    /**
     * Optional template for the action, if not provided, it will be generated from the content class
     */
    protected readonly template: string;
    /**
     * Optional content schema for the action, if not provided, it will be generated from the content class
     */
    protected readonly contentSchema: z.ZodSchema<T>;

    /**
     * Constructor for the base injectable action
     */
    constructor(opts: ActionOptions<T>) {
        // Set the action properties
        this.name = opts.name;
        this.similes = opts.similes;
        this.description = opts.description;
        this.examples = opts.examples;
        this.suppressInitialMessage = opts.suppressInitialMessage ?? false; // Default to false
        // Set the content class, template and content schema
        this.contentClass = opts.contentClass;
        this.template = opts.template;
        this.contentSchema = opts.contentSchema;

        if (this.contentClass !== undefined) {
            if (this.contentSchema === undefined) {
                this.contentSchema = createZodSchema(this.contentClass);
            }
            if (this.template === undefined) {
                const properties = loadPropertyDescriptions(this.contentClass);
                this.template = buildContentOutputTemplate(
                    this.name,
                    this.description,
                    properties,
                    this.contentSchema
                );
            }
        }
    }

    // -------- Abstract methods to be implemented by the child class --------

    /**
     * Abstract method to execute the action
     * @param content The content object
     * @param callback The callback function to pass the result to Eliza runtime
     */
    abstract execute(
        content: T | null,
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        callback?: HandlerCallback
    ): Promise<any | null>;

    // -------- Implemented methods for Eliza runtime --------

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
     * Default implementation of the preparation of action context
     * You can override this method to add custom logic
     *
     * @param runtime The runtime object from Eliza framework
     * @param message The message object from Eliza framework
     * @param state The state object from Eliza framework
     */
    protected async prepareActionContext(
        runtime: IAgentRuntime,
        message: Memory,
        state?: State
    ): Promise<string> {
        // Initialize or update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        } else {
            state = await runtime.updateRecentMessageState(state);
        }

        // Compose context
        return composeContext({ state, template: this.template });
    }

    /**
     * Default method for processing messages
     * You can override this method to add custom logic
     *
     * @param runtime The runtime object from Eliza framework
     * @param message The message object from Eliza framework
     * @param state The state object from Eliza framework
     * @returns The generated content from AI based on the message
     */
    protected async processMessages(
        runtime: IAgentRuntime,
        message: Memory,
        state: State
    ): Promise<T | null> {
        const actionContext = await this.prepareActionContext(
            runtime,
            message,
            state
        );

        if (!actionContext) {
            elizaLogger.error("Failed to prepare action context");
            return null;
        }

        // Generate transfer content
        const resourceDetails = await generateObject({
            runtime,
            context: actionContext,
            modelClass: ModelClass.SMALL,
            schema: this.contentSchema as z.ZodSchema<any>,
        });

        elizaLogger.debug("Response: ", resourceDetails.object);

        // Validate content
        const parsedObj = await this.contentSchema.safeParseAsync(
            resourceDetails.object
        );
        if (!parsedObj.success) {
            elizaLogger.error(
                "Failed to parse content: ",
                JSON.stringify(parsedObj.error?.flatten())
            );
            return null;
        } else {
            return parsedObj.data;
        }
    }

    /**
     * Default Handler function type for processing messages
     * You can override this method to add custom logic
     *
     * @param runtime The runtime object from Eliza framework
     * @param message The message object from Eliza framework
     * @param state The state object from Eliza framework
     * @param options The options object from Eliza framework
     * @param callback The callback function to pass the result to Eliza runtime
     */
    async handler(
        runtime: IAgentRuntime,
        message: Memory,
        state?: State,
        _options?: Record<string, unknown>,
        callback?: HandlerCallback
    ): Promise<any | null> {
        let content: T;
        try {
            content = await this.processMessages(runtime, message, state);
        } catch (err) {
            elizaLogger.error("Error in processing messages:", err.message);

            if (callback) {
                await callback?.({
                    text:
                        "Unable to process transfer request. Invalid content: " +
                        err.message,
                    content: {
                        error: "Invalid content",
                    },
                });
            }
            return null;
        }

        try {
            return await this.execute(
                content,
                runtime,
                message,
                state,
                callback
            );
        } catch (err) {
            elizaLogger.error("Error in executing action:", err.message);
        }
    }
}
