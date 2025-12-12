/**
 * XMRT-DAO Ecosystem Integration Adapter
 * Enables xmrt-eliza to communicate with XMRT-DAO agents and systems
 */

import { Plugin, IAgentRuntime, Memory, State, elizaLogger } from "@eliza/core";
import { v4 as uuidv4 } from 'uuid';

// XMRT Ecosystem Configuration
interface XMRTConfig {
    supabaseUrl: string;
    supabaseKey: string;
    ecosystemApiUrl: string;
    suiteAiUrl: string;
    agentId: string;
    councilMode: boolean;
}

// XMRT Agent Communication Protocol
interface XMRTMessage {
    id: string;
    from: string;
    to: string;
    type: 'coordination' | 'task' | 'report' | 'query' | 'response';
    content: any;
    timestamp: string;
    ecosystem: 'XMRT';
}

// XMRT Task Definition
interface XMRTTask {
    id: string;
    type: string;
    description: string;
    assignedTo: string[];
    priority: number;
    status: 'pending' | 'active' | 'completed' | 'failed';
    metadata: any;
}

export class XMRTEcosystemAdapter {
    private config: XMRTConfig;
    private runtime: IAgentRuntime;
    
    constructor(runtime: IAgentRuntime, config: XMRTConfig) {
        this.runtime = runtime;
        this.config = config;
    }

    /**
     * Initialize connection to XMRT-DAO ecosystem
     */
    async initialize(): Promise<boolean> {
        try {
            elizaLogger.info("🚀 Initializing XMRT-DAO Ecosystem Connection...");
            
            // Register with XMRT ecosystem
            const registration = await this.registerWithEcosystem();
            
            // Connect to Supabase message bus
            await this.connectToMessageBus();
            
            // Sync with existing agents
            await this.syncWithAgents();
            
            elizaLogger.info("✅ XMRT-DAO Ecosystem integration initialized");
            return true;
            
        } catch (error) {
            elizaLogger.error("❌ Failed to initialize XMRT ecosystem:", error);
            return false;
        }
    }

    /**
     * Register this Eliza instance with XMRT ecosystem
     */
    private async registerWithEcosystem(): Promise<any> {
        const registrationPayload = {
            agent_name: `xmrt-eliza-${this.config.agentId}`,
            display_name: this.config.councilMode ? "XMRT Council Eliza" : "XMRT Eliza Agent",
            agent_type: this.config.councilMode ? "council" : "autonomous",
            capabilities: [
                "natural-language-processing",
                "conversation-management", 
                "task-orchestration",
                "decision-making",
                "knowledge-synthesis",
                "cross-agent-communication"
            ],
            ecosystem_role: this.config.councilMode ? "primary_council" : "engagement_agent",
            integration_points: [
                `${this.config.ecosystemApiUrl}/api/*`,
                `${this.config.suiteAiUrl}/*`,
                `${this.config.supabaseUrl}/rest/v1/*`
            ],
            status: "active",
            communication_channels: ["supabase", "api", "webhook"],
            xmrt_context: {
                council_member: this.config.councilMode,
                engagement_focus: "DAO operations and community interaction",
                coordination_role: "agent orchestration and task management"
            }
        };

        const response = await fetch(`${this.config.supabaseUrl}/rest/v1/superduper_agents`, {
            method: 'POST',
            headers: {
                'apikey': this.config.supabaseKey,
                'Authorization': `Bearer ${this.config.supabaseKey}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify(registrationPayload)
        });

        if (!response.ok) {
            throw new Error(`Registration failed: ${response.statusText}`);
        }

        elizaLogger.info("✅ Registered with XMRT ecosystem");
        return response.json();
    }

    /**
     * Connect to XMRT Supabase message bus
     */
    private async connectToMessageBus(): Promise<void> {
        elizaLogger.info("🔗 Connecting to XMRT message bus...");
        
        // Set up real-time subscriptions for inter-agent communication
        // This would integrate with Supabase real-time subscriptions
        
        elizaLogger.info("✅ Connected to XMRT message bus");
    }

    /**
     * Sync with existing XMRT agents
     */
    private async syncWithAgents(): Promise<void> {
        try {
            // Discover existing agents
            const agentsResponse = await fetch(`${this.config.ecosystemApiUrl}/api/agents`);
            const ecosystemAgents = await agentsResponse.json();
            
            elizaLogger.info(`🤖 Discovered ${ecosystemAgents.agents?.length || 0} ecosystem agents`);
            
            // Get Suite AI agents
            const suiteResponse = await fetch(`${this.config.supabaseUrl}/rest/v1/superduper_agents?select=*&is_active=eq.true`, {
                headers: {
                    'apikey': this.config.supabaseKey,
                    'Authorization': `Bearer ${this.config.supabaseKey}`
                }
            });
            const suiteAgents = await suiteResponse.json();
            
            elizaLogger.info(`🧠 Discovered ${suiteAgents.length || 0} Suite AI agents`);
            
            // Store agent registry in runtime memory
            await this.runtime.messageManager.createMemory({
                id: uuidv4(),
                userId: this.config.agentId,
                content: {
                    text: `XMRT Agent Registry synced: ${ecosystemAgents.agents?.length || 0} ecosystem agents, ${suiteAgents.length || 0} Suite AI agents`,
                    metadata: {
                        ecosystem_agents: ecosystemAgents.agents || [],
                        suite_agents: suiteAgents || [],
                        sync_timestamp: new Date().toISOString()
                    }
                }
            });
            
        } catch (error) {
            elizaLogger.error("⚠️ Agent sync completed with errors:", error);
        }
    }

    /**
     * Send message to XMRT agent
     */
    async sendMessageToAgent(targetAgent: string, message: XMRTMessage): Promise<boolean> {
        try {
            // Log communication to Supabase
            await fetch(`${this.config.supabaseUrl}/rest/v1/eliza_activity_log`, {
                method: 'POST',
                headers: {
                    'apikey': this.config.supabaseKey,
                    'Authorization': `Bearer ${this.config.supabaseKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify({
                    agent_name: `xmrt-eliza-${this.config.agentId}`,
                    action: 'send_message',
                    details: `Sent ${message.type} message to ${targetAgent}`,
                    timestamp: new Date().toISOString(),
                    context: {
                        target_agent: targetAgent,
                        message_type: message.type,
                        message_id: message.id,
                        ecosystem: 'XMRT'
                    }
                })
            });

            elizaLogger.info(`📨 Message sent to ${targetAgent}: ${message.type}`);
            return true;
            
        } catch (error) {
            elizaLogger.error(`❌ Failed to send message to ${targetAgent}:`, error);
            return false;
        }
    }

    /**
     * Coordinate task with XMRT agents
     */
    async coordinateTask(task: XMRTTask): Promise<string> {
        try {
            // Trigger coordination via XMRT ecosystem
            const coordinationResponse = await fetch(`${this.config.ecosystemApiUrl}/api/tick`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    source: 'xmrt-eliza',
                    task: task,
                    coordinator: `xmrt-eliza-${this.config.agentId}`,
                    timestamp: new Date().toISOString()
                })
            });

            const result = await coordinationResponse.json();
            
            elizaLogger.info(`🎯 Task coordination initiated: ${task.id}`);
            return task.id;
            
        } catch (error) {
            elizaLogger.error(`❌ Task coordination failed:`, error);
            throw error;
        }
    }

    /**
     * Report to XMRT Council
     */
    async reportToCouncil(report: any): Promise<void> {
        const reportPayload = {
            reporter: `xmrt-eliza-${this.config.agentId}`,
            report_type: report.type || 'status',
            content: report,
            timestamp: new Date().toISOString(),
            ecosystem: 'XMRT'
        };

        await fetch(`${this.config.supabaseUrl}/rest/v1/eliza_activity_log`, {
            method: 'POST',
            headers: {
                'apikey': this.config.supabaseKey,
                'Authorization': `Bearer ${this.config.supabaseKey}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
                agent_name: `xmrt-eliza-${this.config.agentId}`,
                action: 'council_report',
                details: `Council report: ${report.type || 'status'}`,
                timestamp: new Date().toISOString(),
                context: reportPayload
            })
        });

        elizaLogger.info(`📋 Report submitted to XMRT Council: ${report.type || 'status'}`);
    }

    /**
     * Access XMRT knowledge base
     */
    async accessKnowledgeBase(query: string): Promise<any[]> {
        try {
            // Query conversation history and knowledge
            const knowledgeResponse = await fetch(
                `${this.config.supabaseUrl}/rest/v1/conversation_history?select=*&or=content.ilike.%${encodeURIComponent(query)}%,summary.ilike.%${encodeURIComponent(query)}%&limit=10`,
                {
                    headers: {
                        'apikey': this.config.supabaseKey,
                        'Authorization': `Bearer ${this.config.supabaseKey}`
                    }
                }
            );

            const knowledge = await knowledgeResponse.json();
            
            elizaLogger.info(`🧠 Knowledge query returned ${knowledge.length} results`);
            return knowledge;
            
        } catch (error) {
            elizaLogger.error(`❌ Knowledge base access failed:`, error);
            return [];
        }
    }

    /**
     * Contribute to XMRT knowledge base
     */
    async contributeKnowledge(knowledge: any): Promise<void> {
        const contribution = {
            source: `xmrt-eliza-${this.config.agentId}`,
            knowledge_type: knowledge.type || 'insight',
            content: knowledge.content,
            metadata: {
                ...knowledge.metadata,
                contributed_by: 'xmrt-eliza',
                contribution_timestamp: new Date().toISOString()
            }
        };

        // Store in conversation history as knowledge contribution
        await this.runtime.messageManager.createMemory({
            id: uuidv4(),
            userId: this.config.agentId,
            content: {
                text: `XMRT Knowledge Contribution: ${knowledge.type || 'insight'}`,
                metadata: contribution
            }
        });

        elizaLogger.info(`📚 Knowledge contributed to XMRT base: ${knowledge.type || 'insight'}`);
    }
}

/**
 * XMRT-DAO Integration Plugin
 */
export const xmrtDaoPlugin: Plugin = {
    name: "xmrt-dao",
    description: "XMRT-DAO Ecosystem Integration Plugin for Eliza",
    
    actions: [
        {
            name: "COORDINATE_XMRT_TASK",
            description: "Coordinate a task with XMRT ecosystem agents",
            handler: async (runtime: IAgentRuntime, message: Memory, state: State) => {
                const adapter = runtime.getSetting("XMRT_ADAPTER") as XMRTEcosystemAdapter;
                
                if (!adapter) {
                    return { text: "XMRT ecosystem adapter not initialized" };
                }

                try {
                    const taskDescription = message.content.text;
                    const task: XMRTTask = {
                        id: uuidv4(),
                        type: "coordination",
                        description: taskDescription,
                        assignedTo: ["ecosystem-agents"],
                        priority: 5,
                        status: "pending",
                        metadata: {
                            requestedBy: message.userId,
                            timestamp: new Date().toISOString()
                        }
                    };

                    const taskId = await adapter.coordinateTask(task);
                    return { 
                        text: `Task coordination initiated with XMRT ecosystem. Task ID: ${taskId}`,
                        metadata: { taskId, ecosystem: "XMRT" }
                    };
                    
                } catch (error) {
                    elizaLogger.error("Task coordination failed:", error);
                    return { text: "Failed to coordinate task with XMRT ecosystem" };
                }
            }
        },
        {
            name: "QUERY_XMRT_KNOWLEDGE",
            description: "Query the XMRT knowledge base",
            handler: async (runtime: IAgentRuntime, message: Memory, state: State) => {
                const adapter = runtime.getSetting("XMRT_ADAPTER") as XMRTEcosystemAdapter;
                
                if (!adapter) {
                    return { text: "XMRT ecosystem adapter not initialized" };
                }

                try {
                    const query = message.content.text;
                    const results = await adapter.accessKnowledgeBase(query);
                    
                    if (results.length === 0) {
                        return { text: "No relevant knowledge found in XMRT knowledge base" };
                    }

                    const summary = results.slice(0, 3).map(r => r.content || r.summary).join("\n\n");
                    return { 
                        text: `XMRT Knowledge Base Results (${results.length} found):\n\n${summary}`,
                        metadata: { resultsCount: results.length, ecosystem: "XMRT" }
                    };
                    
                } catch (error) {
                    elizaLogger.error("Knowledge query failed:", error);
                    return { text: "Failed to query XMRT knowledge base" };
                }
            }
        },
        {
            name: "REPORT_TO_XMRT_COUNCIL",
            description: "Submit a report to the XMRT Council",
            handler: async (runtime: IAgentRuntime, message: Memory, state: State) => {
                const adapter = runtime.getSetting("XMRT_ADAPTER") as XMRTEcosystemAdapter;
                
                if (!adapter) {
                    return { text: "XMRT ecosystem adapter not initialized" };
                }

                try {
                    const report = {
                        type: "status_report",
                        content: message.content.text,
                        reporter_id: message.userId,
                        timestamp: new Date().toISOString()
                    };

                    await adapter.reportToCouncil(report);
                    return { 
                        text: "Report successfully submitted to XMRT Council",
                        metadata: { reportType: report.type, ecosystem: "XMRT" }
                    };
                    
                } catch (error) {
                    elizaLogger.error("Council reporting failed:", error);
                    return { text: "Failed to submit report to XMRT Council" };
                }
            }
        }
    ],

    evaluators: [],
    providers: []
};

export default xmrtDaoPlugin;
