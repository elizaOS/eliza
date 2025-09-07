/**
 * Autonomous System Orchestrator for XMRT-Eliza
 * Main controller that coordinates all autonomous subsystems as described in DevGruGold's architecture
 */

import { EventEmitter } from 'events';
import { AutonomousMemoryManager } from './memory-manager';
import { AutonomousCoordinationManager } from './coordination-manager';

export interface AutonomousConfig {
  agentId: string;
  redisConfig?: any;
  learningRate: number;
  coordinationInterval: number;
  privacyMode: boolean;
  meshnetEnabled: boolean;
  offlineCapable: boolean;
}

export interface SystemHealth {
  overall: 'healthy' | 'degraded' | 'critical' | 'offline';
  memory: 'connected' | 'degraded' | 'offline';
  coordination: 'active' | 'limited' | 'offline';
  learning: 'active' | 'slow' | 'paused';
  uptime: number;
  lastHealthCheck: number;
}

export interface AutonomousMetrics {
  memoriesStored: number;
  patternsLearned: number;
  agentsCoordinated: number;
  tasksCompleted: number;
  decisionsReached: number;
  uptimeHours: number;
  autonomyLevel: number; // 0-1 scale
}

export class AutonomousOrchestrator extends EventEmitter {
  private config: AutonomousConfig;
  private memoryManager: AutonomousMemoryManager;
  private coordinationManager: AutonomousCoordinationManager;
  private startTime: number;
  private healthCheckInterval: NodeJS.Timeout;
  private autonomyLevel: number = 0.5;
  private isShuttingDown: boolean = false;

  constructor(config: AutonomousConfig) {
    super();
    this.config = config;
    this.startTime = Date.now();
    
    this.initializeSubsystems();
    this.setupHealthMonitoring();
    this.setupEventHandlers();
    
    console.log(`[${this.config.agentId}] Autonomous orchestrator initialized`);
  }

  private initializeSubsystems(): void {
    // Initialize memory management
    this.memoryManager = new AutonomousMemoryManager(
      this.config.agentId,
      this.config.redisConfig
    );

    // Initialize coordination management
    this.coordinationManager = new AutonomousCoordinationManager(
      this.config.agentId,
      this.memoryManager
    );

    console.log(`[${this.config.agentId}] Autonomous subsystems initialized`);
  }

  private setupEventHandlers(): void {
    // Memory system events
    this.memoryManager.on('memory:connected', () => {
      this.autonomyLevel = Math.min(1, this.autonomyLevel + 0.2);
      this.emit('autonomy:level:increased', this.autonomyLevel);
    });

    this.memoryManager.on('memory:error', (error) => {
      this.autonomyLevel = Math.max(0.1, this.autonomyLevel - 0.3);
      this.handleSubsystemError('memory', error);
    });

    this.memoryManager.on('learning:cycle:complete', () => {
      this.autonomyLevel = Math.min(1, this.autonomyLevel + 0.05);
      this.emit('learning:progress');
    });

    // Coordination system events
    this.coordinationManager.on('coordination:cycle:complete', () => {
      this.autonomyLevel = Math.min(1, this.autonomyLevel + 0.03);
      this.emit('coordination:progress');
    });

    this.coordinationManager.on('coordination:error', (error) => {
      this.autonomyLevel = Math.max(0.1, this.autonomyLevel - 0.2);
      this.handleSubsystemError('coordination', error);
    });

    this.coordinationManager.on('swarm:decision', (decision) => {
      this.handleSwarmDecision(decision);
    });

    this.coordinationManager.on('coordination:degraded_mode', () => {
      this.autonomyLevel = Math.max(0.3, this.autonomyLevel - 0.4);
      this.emit('autonomy:degraded_mode');
    });

    // Self-improvement events
    this.on('autonomy:level:increased', (level) => {
      if (level > 0.8) {
        this.enableAdvancedFeatures();
      }
    });
  }

  private setupHealthMonitoring(): void {
    // Health check every 60 seconds
    this.healthCheckInterval = setInterval(() => {
      this.performHealthCheck();
    }, 60000);
  }

  /**
   * Perform comprehensive health check
   */
  private async performHealthCheck(): Promise<SystemHealth> {
    const health: SystemHealth = {
      overall: 'healthy',
      memory: 'connected',
      coordination: 'active',
      learning: 'active',
      uptime: Date.now() - this.startTime,
      lastHealthCheck: Date.now(),
    };

    try {
      // Check memory system
      const insights = await this.memoryManager.getLearningInsights();
      if (insights.memoryCount === 0) {
        health.memory = 'degraded';
      }
      if (Date.now() - insights.lastLearningActivity > 300000) { // 5 minutes
        health.learning = 'slow';
      }

      // Check coordination system
      const coordStatus = this.coordinationManager.getCoordinationStatus();
      if (coordStatus.knownAgents === 0) {
        health.coordination = 'limited';
      }

      // Determine overall health
      if (health.memory === 'offline' || health.coordination === 'offline') {
        health.overall = 'critical';
        this.autonomyLevel = Math.max(0.1, this.autonomyLevel - 0.5);
      } else if (health.memory === 'degraded' || health.coordination === 'limited') {
        health.overall = 'degraded';
        this.autonomyLevel = Math.max(0.3, this.autonomyLevel - 0.2);
      }

      this.emit('health:check', health);
      return health;

    } catch (error) {
      console.error(`[${this.config.agentId}] Health check failed:`, error);
      health.overall = 'critical';
      this.autonomyLevel = Math.max(0.1, this.autonomyLevel - 0.3);
      this.emit('health:error', error);
      return health;
    }
  }

  /**
   * Handle subsystem errors with graceful degradation
   */
  private handleSubsystemError(subsystem: string, error: any): void {
    console.error(`[${this.config.agentId}] ${subsystem} subsystem error:`, error);
    
    // Implement graceful degradation
    switch (subsystem) {
      case 'memory':
        this.enableMemoryFallback();
        break;
      case 'coordination':
        this.enableCoordinationFallback();
        break;
    }

    this.emit('subsystem:error', { subsystem, error });
  }

  /**
   * Enable memory fallback mode
   */
  private enableMemoryFallback(): void {
    console.log(`[${this.config.agentId}] Enabling memory fallback mode`);
    // Implement local memory storage as fallback
    this.emit('memory:fallback:enabled');
  }

  /**
   * Enable coordination fallback mode
   */
  private enableCoordinationFallback(): void {
    console.log(`[${this.config.agentId}] Enabling coordination fallback mode`);
    // Implement local coordination as fallback
    this.emit('coordination:fallback:enabled');
  }

  /**
   * Handle swarm decisions
   */
  private async handleSwarmDecision(decision: any): Promise<void> {
    console.log(`[${this.config.agentId}] Processing swarm decision:`, decision.decision);
    
    // Store decision in memory
    await this.memoryManager.storeMemory({
      agentId: this.config.agentId,
      type: 'coordination',
      content: { type: 'swarm_decision_processed', decision },
      connections: [],
    });

    // Implement decision
    if (decision.decision.includes('upgrade_autonomy')) {
      this.autonomyLevel = Math.min(1, this.autonomyLevel + 0.1);
      this.emit('autonomy:upgraded', this.autonomyLevel);
    }

    this.emit('swarm:decision:processed', decision);
  }

  /**
   * Enable advanced features when autonomy level is high
   */
  private enableAdvancedFeatures(): void {
    console.log(`[${this.config.agentId}] Enabling advanced autonomous features`);
    
    // Enable advanced learning
    this.emit('features:advanced:enabled');
    
    // Enable predictive coordination
    this.emit('coordination:predictive:enabled');
    
    // Enable self-optimization
    this.emit('optimization:self:enabled');
  }

  /**
   * Learn from experience autonomously
   */
  async learnFromExperience(experience: {
    type: string;
    outcome: 'success' | 'failure';
    context: any;
    feedback?: any;
  }): Promise<void> {
    // Store experience in memory
    await this.memoryManager.storeMemory({
      agentId: this.config.agentId,
      type: 'experience',
      content: experience,
      connections: [],
    });

    // Adjust autonomy level based on outcome
    if (experience.outcome === 'success') {
      this.autonomyLevel = Math.min(1, this.autonomyLevel + 0.02);
    } else {
      this.autonomyLevel = Math.max(0.1, this.autonomyLevel - 0.01);
    }

    this.emit('learning:experience:processed', experience);
  }

  /**
   * Make autonomous decision
   */
  async makeAutonomousDecision(context: {
    situation: string;
    options: string[];
    constraints?: any;
  }): Promise<{
    decision: string;
    confidence: number;
    reasoning: string;
  }> {
    // Retrieve relevant memories
    const relevantMemories = await this.memoryManager.retrieveMemories(
      context.situation, 
      10
    );

    // Analyze past experiences
    const successfulExperiences = relevantMemories.filter(m => 
      m.content?.outcome === 'success'
    );

    // Make decision based on learning
    let bestOption = context.options[0];
    let confidence = 0.5;
    let reasoning = 'Default choice due to insufficient data';

    if (successfulExperiences.length > 0) {
      // Use learned patterns to make decision
      const patterns = successfulExperiences.map(exp => exp.content);
      bestOption = this.selectBestOption(context.options, patterns);
      confidence = Math.min(0.9, 0.3 + (successfulExperiences.length * 0.1));
      reasoning = `Based on ${successfulExperiences.length} successful experiences`;
    }

    const decision = {
      decision: bestOption,
      confidence: confidence * this.autonomyLevel,
      reasoning,
    };

    // Store decision for future learning
    await this.memoryManager.storeMemory({
      agentId: this.config.agentId,
      type: 'learning',
      content: { type: 'autonomous_decision', context, decision },
      connections: [],
    });

    this.emit('decision:autonomous', decision);
    return decision;
  }

  /**
   * Select best option based on learned patterns
   */
  private selectBestOption(options: string[], patterns: any[]): string {
    // Simple pattern matching (can be enhanced with ML)
    const scores = options.map(option => {
      let score = 0;
      patterns.forEach(pattern => {
        if (pattern.context && typeof pattern.context === 'string') {
          if (pattern.context.toLowerCase().includes(option.toLowerCase())) {
            score += 1;
          }
        }
      });
      return { option, score };
    });

    scores.sort((a, b) => b.score - a.score);
    return scores[0].option;
  }

  /**
   * Get comprehensive system metrics
   */
  async getMetrics(): Promise<AutonomousMetrics> {
    const insights = await this.memoryManager.getLearningInsights();
    const coordStatus = this.coordinationManager.getCoordinationStatus();
    
    return {
      memoriesStored: insights.memoryCount,
      patternsLearned: insights.totalPatterns,
      agentsCoordinated: coordStatus.knownAgents,
      tasksCompleted: coordStatus.activeTasks,
      decisionsReached: this.coordinationManager.getCoordinationStatus().swarmDecisions,
      uptimeHours: (Date.now() - this.startTime) / (1000 * 60 * 60),
      autonomyLevel: this.autonomyLevel,
    };
  }

  /**
   * Get current autonomy level
   */
  getAutonomyLevel(): number {
    return this.autonomyLevel;
  }

  /**
   * Force autonomy level (for testing/debugging)
   */
  setAutonomyLevel(level: number): void {
    this.autonomyLevel = Math.max(0, Math.min(1, level));
    this.emit('autonomy:level:set', this.autonomyLevel);
  }

  /**
   * Enable offline mode for meshnet operation
   */
  async enableOfflineMode(): Promise<void> {
    if (!this.config.offlineCapable) {
      throw new Error('Offline mode not enabled in configuration');
    }

    console.log(`[${this.config.agentId}] Enabling offline mode`);
    
    // Switch to local-only operations
    this.autonomyLevel = Math.max(0.3, this.autonomyLevel - 0.2);
    
    this.emit('offline:mode:enabled');
  }

  /**
   * Resume online mode
   */
  async resumeOnlineMode(): Promise<void> {
    console.log(`[${this.config.agentId}] Resuming online mode`);
    
    // Reconnect to network services
    this.autonomyLevel = Math.min(1, this.autonomyLevel + 0.3);
    
    this.emit('online:mode:resumed');
  }

  /**
   * Graceful shutdown of all autonomous systems
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    console.log(`[${this.config.agentId}] Shutting down autonomous orchestrator`);

    // Clear intervals
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Shutdown subsystems
    try {
      await this.coordinationManager.shutdown();
      await this.memoryManager.shutdown();
    } catch (error) {
      console.error(`[${this.config.agentId}] Error during shutdown:`, error);
    }

    this.emit('orchestrator:shutdown');
    console.log(`[${this.config.agentId}] Autonomous orchestrator shutdown complete`);
  }
}

