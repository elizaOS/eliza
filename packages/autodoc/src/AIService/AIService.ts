import { ChatOpenAI } from "@langchain/openai";
import dotenv from "dotenv";
import type { Configuration } from "../Configuration.js";
import { TypeScriptParser } from "../TypeScriptParser.js";
import { CodeFormatter } from "./utils/CodeFormatter.js";
import { DocumentOrganizer } from "./utils/DocumentOrganizer.js";
import { processText } from "./objectStore.js";

dotenv.config();

/**
 * Service for interacting with OpenAI chat API.
 */
/**
 * Class representing an AI service for generating comments based on prompts.
 */

export class AIService {
	private chatModel: ChatOpenAI;
	private codeFormatter: CodeFormatter;
	private chatModelFAQ: ChatOpenAI;

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
	    
	    let defaultCreds = { apiKey: process.env.OPENAI_API_KEY , configuration:{}}
	    if (process.env.OPENAI_API_BASE) {
		//console.log("OPENAI_API_BASE",process.env.OPENAI_API_BASE);
		defaultCreds.configuration = { "basePath" : process.env.OPENAI_API_BASE }
	    }

	    //console.log("DEFAULT_CREDS",defaultCreds);
	    this.chatModel = new ChatOpenAI(defaultCreds)
	    this.chatModelFAQ = new ChatOpenAI({ ...defaultCreds, ...{model: "gpt-4o"}});
	    this.codeFormatter = new CodeFormatter();
	}

	private async _generateComment(finalPrompt: string, isFAQ = false): Promise<string> {
		if (!process.env.NOAI) {
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
				"Token limit exceeded, attempting with further truncation...",
			    );
			    // Try with more aggressive truncation
			    finalPrompt = this.codeFormatter.truncateCodeBlock(finalPrompt, 4000);
			    try {
				const response = await this.chatModel.invoke(finalPrompt);
				return response.content as string;
			    } catch (retryError) {
				if (
				    retryError instanceof Error &&
					retryError.message.includes("maximum context length")
				) {
				    console.warn(
					"Still exceeding token limit, using minimal context...",
				    );
				    // Final attempt with minimal context
				    finalPrompt = this.codeFormatter.truncateCodeBlock(finalPrompt, 2000);
				    const response = await this.chatModel.invoke(finalPrompt);
				    return response.content as string;
				}
				throw retryError;
			    }
			}
			throw error;
		    }
		}
		else {
		    //console.log("SKIP");
		    return '{ "title": "no ai", "body": "body" }'
		}					    
	
	}
	/**
	 * Generates a comment based on the specified prompt by invoking the chat model.
	 * @param {string} prompt - The prompt for which to generate a comment
	 * @returns {Promise<string>} The generated comment
	 */
	public async generateComment(prompt: string, isFAQ = false): Promise<string> {
	    
		// First try with generous limit
		let finalPrompt = prompt;
		if (!isFAQ) {
		    finalPrompt = this.codeFormatter.truncateCodeBlock(prompt, 8000);
		}
		
		console.log(
		    `Generating comment for prompt of length: ${finalPrompt.length}`,
		);

		let result= await this._generateComment(finalPrompt, isFAQ);
		processText(finalPrompt, result);
		
		return result
	
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



