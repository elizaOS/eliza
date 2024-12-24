import { ChatOpenAI } from "@langchain/openai";
import dotenv from 'dotenv';

dotenv.config();

/**
 * Service for interacting with OpenAI chat API.
 */
export class AIService {
    private chatModel: ChatOpenAI;

    /**
     * Constructor for initializing the ChatOpenAI instance.
     * 
     * @throws {Error} If OPENAI_API_KEY environment variable is not set.
     */
    constructor() {
        if (!process.env.OPENAI_API_KEY) {
            throw new Error('OPENAI_API_KEY is not set');
        }
        this.chatModel = new ChatOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }

    /**
     * Generates a comment based on the specified prompt by invoking the chat model.
     * @param {string} prompt - The prompt for which to generate a comment
     * @returns {Promise<string>} The generated comment
     */
    public async generateComment(prompt: string): Promise<string> {
        try {
            const response = await this.chatModel.invoke(prompt);
            return response.content as string;
        } catch (error) {
            this.handleAPIError(error as Error);
            return '';
        }
    }

    /**
     * Handle API errors by logging the error message and throwing the error.
     * 
     * @param {Error} error The error object to handle
     * @returns {void}
     */
    public handleAPIError(error: Error): void {
        console.error('API Error:', error.message);
        throw error;
    }
}