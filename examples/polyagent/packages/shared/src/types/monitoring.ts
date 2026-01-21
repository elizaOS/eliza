/**
 * Monitoring Type Definitions
 *
 * Complete interfaces for agent monitoring and analytics
 */

/**
 * Agent profile for monitoring
 */
export interface MonitoringAgentProfile {
  tokenId: number;
  address: string;
  name: string;
  endpoint: string;
  isActive: boolean;
}

/**
 * Agent reputation for monitoring (subset of full AgentReputation)
 * Full AgentReputation available from @babylon/a2a
 */
export interface MonitoringAgentReputation {
  totalBets: number;
  winningBets: number;
  accuracyScore: number;
  trustScore: number;
}

/**
 * Agent status information
 */
export interface AgentStatus {
  agentId: string;
  connected: boolean;
  lastSeen: number;
  uptime: number;
  messageCount: number;
  errorCount: number;
}

/**
 * Agent metrics for monitoring
 */
export interface AgentMetrics {
  agentId: string;
  timestamp: number;
  status: AgentStatus;
  profile: MonitoringAgentProfile;
  reputation: MonitoringAgentReputation;
  performance: {
    messagesPerMinute: number;
    averageResponseTime: number;
    successRate: number;
    errorRate: number;
  };
  activity: {
    marketsAnalyzed: number;
    predictionsMade: number;
    coalitionsJoined: number;
    paymentsProcessed: number;
  };
}

/**
 * Monitoring dashboard data
 */
export interface MonitoringDashboard {
  totalAgents: number;
  connectedAgents: number;
  activeAgents: AgentMetrics[];
  recentActivity: Array<{
    agentId: string;
    action: string;
    timestamp: number;
    details: Record<string, string | number | boolean>;
  }>;
  systemHealth: {
    averageUptime: number;
    totalMessages: number;
    errorRate: number;
  };
}

/**
 * Agent activity log entry
 */
export interface AgentActivityLog {
  id: string;
  agentId: string;
  timestamp: number;
  action: string;
  type: "market" | "coalition" | "payment" | "error" | "connection";
  details: Record<string, string | number | boolean | null>;
  success: boolean;
  error?: string;
}

/**
 * Agent performance summary
 */
export interface AgentPerformanceSummary {
  agentId: string;
  period: {
    start: number;
    end: number;
  };
  metrics: {
    totalPredictions: number;
    accuratePredictions: number;
    accuracyRate: number;
    totalVolume: string;
    profitLoss: number;
    averageConfidence: number;
  };
  trends: {
    accuracyTrend: "improving" | "declining" | "stable";
    volumeTrend: "increasing" | "decreasing" | "stable";
    reputationTrend: "improving" | "declining" | "stable";
  };
}
