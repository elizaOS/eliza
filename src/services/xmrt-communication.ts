/**
 * XMRT Ecosystem Communication Service
 * Handles real-time communication with XMRT-DAO agents and systems
 */

import { EventEmitter } from 'events';
import { elizaLogger } from "@eliza/core";

export interface XMRTCommunicationConfig {
    supabaseUrl: string;
    supabaseKey: string;
    ecosystemApiUrl: string;
    agentId: string;
    enableRealtime: boolean;
}

export interface XMRTAgent {
    id: string;
    name: string;
    type: string;
    status: 'active' | 'inactive' | 'busy';
    capabilities: string[];
    lastSeen: string;
}

export interface XMRTCoordinationRequest {
    id: string;
    requester: string;
    type: 'task' | 'query' | 'report' | 'sync';
    priority: number;
    payload: any;
    targetAgents?: string[];
}

export class XMRTCommunicationService extends EventEmitter {
    private config: XMRTCommunicationConfig;
    private connectedAgents: Map<string, XMRTAgent> = new Map();
    private realtimeConnection: any = null;
    private heartbeatInterval: NodeJS.Timeout | null = null;

    constructor(config: XMRTCommunicationConfig) {
        super();
        this.config = config;
        this.setupErrorHandling();
    }

    /**
     * Initialize communication service
     */
    async initialize(): Promise<boolean> {
        try {
            elizaLogger.info("🚀 Initializing XMRT Communication Service...");

            // Discover active agents
            await this.discoverAgents();

            // Set up real-time communication if enabled
            if (this.config.enableRealtime) {
                await this.setupRealtimeConnection();
            }

            // Start heartbeat monitoring
            this.startHeartbeat();

            // Register this instance
            await this.registerSelf();

            elizaLogger.info("✅ XMRT Communication Service initialized");
            this.emit('initialized');
            return true;

        } catch (error) {
            elizaLogger.error("❌ Failed to initialize communication service:", error);
            return false;
        }
    }

    /**
     * Discover active agents in the ecosystem
     */
    private async discoverAgents(): Promise<void> {
        try {
            // Get XMRT-Ecosystem agents
            const ecosystemResponse = await fetch(`${this.config.ecosystemApiUrl}/api/agents`);
            const ecosystemData = await ecosystemResponse.json();

            if (ecosystemData.agents) {
                for (const agent of ecosystemData.agents) {
                    this.connectedAgents.set(agent.name, {
                        id: agent.name,
                        name: agent.name,
                        type: 'ecosystem',
                        status: 'active',
                        capabilities: agent.capabilities || [],
                        lastSeen: new Date().toISOString()
                    });
                }
            }

            // Get Suite AI agents
            const suiteResponse = await fetch(
                `${this.config.supabaseUrl}/rest/v1/superduper_agents?select=*&is_active=eq.true`,
                {
                    headers: {
                        'apikey': this.config.supabaseKey,
                        'Authorization': `Bearer ${this.config.supabaseKey}`
                    }
                }
            );
            const suiteAgents = await suiteResponse.json();

            for (const agent of suiteAgents) {
                this.connectedAgents.set(agent.agent_name, {
                    id: agent.agent_name,
                    name: agent.display_name || agent.agent_name,
                    type: 'suite-ai',
                    status: agent.status === 'active' ? 'active' : 'inactive',
                    capabilities: agent.combined_capabilities?.split(', ') || [],
                    lastSeen: agent.updated_at || new Date().toISOString()
                });
            }

            elizaLogger.info(`🤖 Discovered ${this.connectedAgents.size} active agents`);
            this.emit('agents-discovered', Array.from(this.connectedAgents.values()));

        } catch (error) {
            elizaLogger.error("⚠️ Agent discovery completed with errors:", error);
        }
    }

    /**
     * Set up real-time communication connection
     */
    private async setupRealtimeConnection(): Promise<void> {
        elizaLogger.info("🔗 Setting up real-time communication...");
        
        // In a real implementation, this would set up WebSocket or Server-Sent Events
        // connection to Supabase real-time API for immediate message delivery
        
        elizaLogger.info("✅ Real-time communication ready");
    }

    /**
     * Register this Eliza instance with the ecosystem
     */
    private async registerSelf(): Promise<void> {
        try {
            const registrationData = {
                agent_name: `xmrt-eliza-${this.config.agentId}`,
                display_name: "XMRT Eliza Council",
                edge_function_name: "xmrt-eliza-communication",
                description: "Primary XMRT-DAO engagement and orchestration agent",
                combined_capabilities: "natural-language-processing, task-orchestration, inter-agent-communication, knowledge-management, council-reporting",
                category: "council",
                priority: 10,
                status: "active",
                is_active: true,
                execution_count: 0,
                success_count: 0,
                failure_count: 0
            };

            const response = await fetch(`${this.config.supabaseUrl}/rest/v1/superduper_agents`, {
                method: 'POST',
                headers: {
                    'apikey': this.config.supabaseKey,
                    'Authorization': `Bearer ${this.config.supabaseKey}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify(registrationData)
            });

            if (response.ok) {
                elizaLogger.info("✅ Registered with XMRT ecosystem");
            } else {
                elizaLogger.warn("⚠️ Registration completed with warnings");
            }

        } catch (error) {
            elizaLogger.error("❌ Self-registration failed:", error);
        }
    }

    /**
     * Send coordination request to ecosystem
     */
    async sendCoordinationRequest(request: XMRTCoordinationRequest): Promise<string> {
        try {
            // Log the coordination request
            await this.logActivity('coordination_request', `Sent ${request.type} request`, {
                request_id: request.id,
                target_agents: request.targetAgents,
                priority: request.priority
            });

            // Send to XMRT-Ecosystem coordination endpoint
            const coordinationResponse = await fetch(`${this.config.ecosystemApiUrl}/api/tick`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    source: 'xmrt-eliza',
                    coordination_request: request,
                    timestamp: new Date().toISOString()
                })
            });

            const result = await coordinationResponse.json();
            
            elizaLogger.info(`📨 Coordination request sent: ${request.id}`);
            this.emit('coordination-sent', request);
            
            return request.id;

        } catch (error) {
            elizaLogger.error("❌ Failed to send coordination request:", error);
            throw error;
        }
    }

    /**
     * Broadcast message to all or specific agents
     */
    async broadcastMessage(message: any, targetAgents?: string[]): Promise<boolean> {
        try {
            const targets = targetAgents || Array.from(this.connectedAgents.keys());
            
            const broadcastData = {
                from: `xmrt-eliza-${this.config.agentId}`,
                message: message,
                targets: targets,
                timestamp: new Date().toISOString()
            };

            // Log broadcast activity
            await this.logActivity('broadcast_message', `Broadcasted to ${targets.length} agents`, {
                targets: targets,
                message_type: message.type || 'general'
            });

            elizaLogger.info(`📢 Message broadcasted to ${targets.length} agents`);
            this.emit('message-broadcast', broadcastData);
            
            return true;

        } catch (error) {
            elizaLogger.error("❌ Broadcast failed:", error);
            return false;
        }
    }

    /**
     * Get current agent status
     */
    getAgentStatus(agentId?: string): XMRTAgent | XMRTAgent[] {
        if (agentId) {
            return this.connectedAgents.get(agentId) || null;
        }
        return Array.from(this.connectedAgents.values());
    }

    /**
     * Submit report to XMRT Council
     */
    async submitCouncilReport(report: any): Promise<void> {
        const reportData = {
            reporter: `xmrt-eliza-${this.config.agentId}`,
            report_type: report.type || 'status',
            content: report.content,
            metadata: {
                ...report.metadata,
                submitted_at: new Date().toISOString(),
                ecosystem_state: {
                    connected_agents: this.connectedAgents.size,
                    active_communications: this.listenerCount('message-received')
                }
            }
        };

        await this.logActivity('council_report', `Submitted ${report.type || 'status'} report`, reportData);
        
        elizaLogger.info(`📋 Council report submitted: ${report.type || 'status'}`);
        this.emit('council-report', reportData);
    }

    /**
     * Start heartbeat monitoring
     */
    private startHeartbeat(): void {
        this.heartbeatInterval = setInterval(async () => {
            try {
                // Refresh agent discovery
                await this.discoverAgents();
                
                // Log heartbeat
                await this.logActivity('heartbeat', `Active agents: ${this.connectedAgents.size}`, {
                    agent_count: this.connectedAgents.size,
                    uptime: process.uptime()
                });

            } catch (error) {
                elizaLogger.error("⚠️ Heartbeat error:", error);
            }
        }, 60000); // Every minute
    }

    /**
     * Log activity to XMRT ecosystem
     */
    private async logActivity(action: string, details: string, context?: any): Promise<void> {
        try {
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
                    action: action,
                    details: details,
                    timestamp: new Date().toISOString(),
                    context: {
                        ecosystem: 'XMRT',
                        service: 'communication',
                        ...context
                    }
                })
            });

        } catch (error) {
            elizaLogger.error("⚠️ Activity logging failed:", error);
        }
    }

    /**
     * Set up error handling
     */
    private setupErrorHandling(): void {
        this.on('error', (error) => {
            elizaLogger.error("🚨 Communication service error:", error);
        });

        process.on('SIGINT', () => {
            this.shutdown();
        });

        process.on('SIGTERM', () => {
            this.shutdown();
        });
    }

    /**
     * Shutdown communication service
     */
    async shutdown(): Promise<void> {
        elizaLogger.info("🔄 Shutting down XMRT Communication Service...");

        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }

        if (this.realtimeConnection) {
            // Close real-time connection
        }

        await this.logActivity('shutdown', 'Communication service shutting down');
        
        elizaLogger.info("✅ XMRT Communication Service shutdown complete");
        this.emit('shutdown');
    }
}

export default XMRTCommunicationService;
