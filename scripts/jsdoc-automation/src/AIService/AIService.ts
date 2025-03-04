//import { AzureOpenAIInput, ChatOpenAI, ChatOpenAIResponseFormat, ChatOpenAIStructuredOutputMethodOptions, ClientOptions, LegacyOpenAIInput, OpenAIChatInput, OpenAIClient, OpenAIToolChoice } from "@langchain/openai";
import dotenv from "dotenv";
import type { Configuration } from "../Configuration.js";

// import { TypeScriptParser } from "../TypeScriptParser.js";
// This is the retriever we will use in RAG
import { CodeFormatter } from "./utils/CodeFormatter.js";
import { DocumentOrganizer } from "./utils/DocumentOrganizer.js";
//import { CustomErrorParams, InputTypeOfTupleWithRest, IssueData, OutputTypeOfTupleWithRest, ParseParams, ParsePathComponent, ParseStatus, RefinementCtx, RefinementEffect, SafeParseReturnType, z, ZodBranded, ZodCatch, ZodCustomIssue, ZodDefault, ZodEffects, ZodError, ZodIntersection, ZodInvalidArgumentsIssue, ZodInvalidDateIssue, ZodInvalidEnumValueIssue, ZodInvalidIntersectionTypesIssue, ZodInvalidLiteralIssue, ZodInvalidReturnTypeIssue, ZodInvalidStringIssue, ZodInvalidUnionDiscriminatorIssue, ZodInvalidUnionIssue, ZodIssueBase, ZodIssueCode, ZodNotFiniteIssue, ZodNotMultipleOfIssue, ZodOptionalDef, ZodParsedType, ZodPipeline, ZodPromise, ZodReadonly, ZodTooBigIssue, ZodTooSmallIssue, ZodTupleDef, ZodUnion, ZodUnrecognizedKeysIssue } from "zod";
//import { StructuredToolInterface, StructuredToolParams } from "@langchain/core/tools.js";
//import { ToolChoice } from "@langchain/core/language_models/chat_models.js";
//import { BaseChatModelParams } from "@langchain/core/language_models/chat_models.js";
//import { FunctionDefinition } from "@langchain/core/language_models/base.js";
//import { BaseFunctionCallOptions } from "@langchain/core/language_models/base.js";
//import { Serialized } from "@langchain/core/dist/load/serializable.js";

//import { ChatOpenAIFields, ChatOpenAICallOptions, ChatOpenAIStructuredOutputMethodOptions } from "./types.js";

dotenv.config();

export class ChatWrapper {
    // private chatModel: ChatOpenAI;
    callKeys: string[] = [];
    lc_serializeable = true;
    lc_secrets = ["apiKey"];
    
    lc_serializable = true;
    lc_aliases = ["chat"];
    temperature = 0.5;
    topP = 1;
    frequencyPenalty= 0;
    presencePenalty= 0;
    n=1000;
    modelName = "gpt-4o";
    model="gpt-4o";       

    constructor({ apiKey, model = "gpt-4o" }: { apiKey: string; model?: string }) {
        // this.chatModel = new ChatOpenAI({ apiKey, model });
    }

    async invoke(prompt: string) {
        // return this.chatModel.invoke( prompt );
        return { content: "mock response" };
    }
}
/**
 * Service for interacting with OpenAI chat API.
 */
export class AIService {
    private chatModel: ChatWrapper; //<ChatOpenAICallOptions>
    private codeFormatter: CodeFormatter;
    private chatModelFAQ: ChatWrapper;// <ChatOpenAICallOptions>

    /**
     * Constructor for initializing the ChatOpenAI instance.
     *
     * @param {Configuration} configuration - The configuration instance to be used
     * @throws {Error} If OPENAI_API_KEY environment variable is not set
     */
    constructor(private configuration: Configuration) {

        if (!process.env.OPENAI_API_KEY) {
            throw new Error("OPENAI_API_KEY is not set");
        }
 
        this.chatModel = new ChatWrapper({ apiKey: process.env.OPENAI_API_KEY });
        this.chatModelFAQ = new ChatWrapper({
            apiKey: process.env.OPENAI_API_KEY,
            model: "gpt-4o",
        });

	//        this.chatModel = new FakeListChatModel({ responses: []});
	//				this.chatModelFAQ = new FakeListChatModel({	    responses: []        });
        this.codeFormatter = new CodeFormatter();
    }


    /**
     * Generates a comment based on the specified prompt by invoking the chat model.
     * @param {string} prompt - The prompt for which to generate a comment
     * @returns {Promise<string>} The generated comment
     */
    public async generateComment(prompt: string, isFAQ = false): Promise<string> {
        try {
            // First try with generous limit
            let finalPrompt = prompt;
            if (!isFAQ) {
                finalPrompt = this.codeFormatter.truncateCodeBlock(prompt, 8000);
            }

            console.log(
                `Generating comment for prompt of length: ${finalPrompt.length}`
            );

            console.log(
              `PRMPT: ${finalPrompt}`
          );
            try {
                let response;
                if (isFAQ) {
                    response = await this.chatModelFAQ.invoke(finalPrompt);
                } else {
                    response = await this.chatModel.invoke(finalPrompt);
                }
                return response.content as string;
            } catch (error) {
                if (
                    error instanceof Error &&
                    error.message.includes("maximum context length")
                ) {
                    console.warn(
                        "Token limit exceeded, attempting with further truncation..."
                    );
                    // Try with more aggressive truncation
                    finalPrompt = this.codeFormatter.truncateCodeBlock(prompt, 4000);
                    try {
                        const response =
                            await this.chatModel.invoke(finalPrompt);
                        return response.content as string;
                    } catch (retryError) {
                        if (
                            retryError instanceof Error &&
                            retryError.message.includes(
                                "maximum context length"
                            )
                        ) {
                            console.warn(
                                "Still exceeding token limit, using minimal context..."
                            );
                            // Final attempt with minimal context
                            finalPrompt = this.codeFormatter.truncateCodeBlock(prompt, 2000);
                            const response =
                                await this.chatModel.invoke(finalPrompt);
                            return response.content as string;
                        }
                        throw retryError;
                    }
                }
                throw error;
            }
        } catch (error) {
            this.handleAPIError(error as Error);
            return "";
        }
    }

    /**
     * Handle API errors by logging the error message and throwing the error.
     *
     *
     * @param {Error} error The error object to handle
     * @returns {void}
     */
    public handleAPIError(error: Error): void {
        console.error("API Error:", error.message);
        throw error;
    }
}
