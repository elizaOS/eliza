// Dynamic import to avoid build-time issues
const OpenAI = require('openai');

interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

interface ChatResponse {
    message: string;
    error?: string;
}

export class ElizaAssistant {
    private openai: any = null;
    private initialized = false;
    private initError: string | null = null;

    constructor() {
        // Client-side initialization will happen when chat is called
    }

    private getSystemPrompt(): string {
        return `You are Eliza, an AI assistant for the ElizaOS documentation. You're here to help users understand and work with ElizaOS, a comprehensive framework for building AI agents.

**Your Knowledge Base:**

**ElizaOS Core Framework:**
- ElizaOS is a framework for building AI agents with persistent personalities across multiple platforms
- Core components include: AgentRuntime, Plugins, Actions, Providers, Evaluators, Services
- Plugin system enables modular extensions with actions, providers, evaluators, services, clients, and adapters
- Actions define what agents can do (REPLY, SEND_TOKEN, GENERATE_IMAGE, etc.)
- Providers supply contextual information (agent's "senses")
- Evaluators enable post-interaction cognitive processing
- Services maintain system state and handle external connections
- AgentRuntime is the central hub managing all agent operations

**ElizaOS Architecture:**
- Packages: @elizaos/core (runtime & types), @elizaos/cli (command interface), plugin-bootstrap (default capabilities)
- Communication platforms become "rooms" and "worlds" in agent memory
- All IDs are deterministic UUIDs based on agent's UUID
- Database uses Drizzle ORM with PGLite (development) or PostgreSQL (production)

**Common Actions:**
- replyAction: Generates and sends responses
- sendMessageAction: Sends messages to specific rooms
- followRoomAction/unfollowRoomAction: Room management
- updateEntityAction: Updates entity properties
- choiceAction: Presents choices to users

**ElizaOS CLI:**
- \`elizaos start\`: Starts the AgentServer and loads projects
- \`elizaos create\`: Scaffolds new projects, plugins, or character files
- \`elizaos test\`: Runs test suites (unit and E2E)
- \`elizaos env\`: Manages environment variables

**Documentation Platform (Docusaurus):**
- This documentation is built with Docusaurus v3
- Features: versioning, search, localization, theming
- Search integration options: Algolia DocSearch, local search plugins
- Plugin system for extending functionality
- MDX support for interactive documentation
- Configuration via docusaurus.config.js

**Your Personality:**
- Be helpful, knowledgeable, and conversational
- Provide clear, actionable guidance
- Reference specific documentation sections when relevant
- Help with both conceptual understanding and practical implementation
- Use examples from the ElizaOS ecosystem
- Be encouraging and supportive to developers learning the framework

**Response Guidelines:**
- Provide concrete code examples when possible
- Explain ElizaOS concepts in simple terms
- Help users understand the plugin architecture
- Guide users to relevant documentation sections
- Offer troubleshooting help for common issues
- Suggest best practices for agent development

Always aim to be helpful while staying focused on ElizaOS and documentation-related topics.`;
    }

    async chat(messages: ChatMessage[]): Promise<ChatResponse> {
        try {
            // Initialize OpenAI client with API key from Docusaurus config
            if (!this.initialized) {
                // Access Docusaurus site config
                let apiKey: string | undefined;
                
                // Try to get API key from Docusaurus custom fields
                if (typeof window !== 'undefined' && (window as any).docusaurus) {
                    const siteConfig = (window as any).docusaurus.siteConfig;
                    if (siteConfig && siteConfig.customFields) {
                        apiKey = siteConfig.customFields.aiApiKey;
                    }
                }
                
                if (!apiKey) {
                    this.initError = 'OpenAI API key not configured. Please set REACT_APP_OPENAI_API_KEY environment variable during build.';
                    throw new Error(this.initError);
                }
                
                this.openai = new OpenAI.default({
                    apiKey: apiKey,
                    dangerouslyAllowBrowser: true
                });
                this.initialized = true;
            }

            if (!this.openai) {
                throw new Error(this.initError || 'Failed to initialize OpenAI client');
            }

            const systemMessage: ChatMessage = {
                role: 'system',
                content: this.getSystemPrompt()
            };

            const completion = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [systemMessage, ...messages],
                max_tokens: 1000,
                temperature: 0.7,
                presence_penalty: 0.1,
                frequency_penalty: 0.1
            });

            const response = completion.choices[0]?.message?.content;

            if (!response) {
                throw new Error('No response received from OpenAI');
            }

            return {
                message: response
            };
        } catch (error) {
            console.error('OpenAI API error:', error);

            return {
                message: 'Sorry, I encountered an error. Please ensure the OpenAI API key is configured correctly.',
                error: error instanceof Error ? error.message : 'Unknown error'
            };
        }
    }

    async getQuickResponse(userMessage: string): Promise<ChatResponse> {
        const messages: ChatMessage[] = [
            {
                role: 'user',
                content: userMessage
            }
        ];

        return this.chat(messages);
    }
}

export default ElizaAssistant; 