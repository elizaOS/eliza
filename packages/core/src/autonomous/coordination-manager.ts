/**
 * Autonomous Coordination Manager for XMRT-Eliza
 * Implements agent-to-agent coordination and swarm intelligence as described in DevGruGold's architecture
 */

import { EventEmitter } from 'events';
import { AutonomousMemoryManager } from './memory-manager';

export interface AgentStatus {
  agentId: string;
  status: 'active' | 'idle' | 'learning' | 'coordinating' | 'offline';
  capabilities: string[];
  currentTask?: string;
  load: number; // 0-1 scale
  lastSeen: number;
  location?: {
    network: string;
    region: string;
    meshNode?: string;
  };
}

export interface CoordinationTask {
  id: string;
  type: 'mining' | 'learning' | 'governance' | 'meshnet' | 'privacy';
  priority: number; // 0-1 scale
  requiredCapabilities: string[];
  assignedAgents: string[];
  status: 'pending' | 'active' | 'completed' | 'failed';
  deadline?: number;
  meshnetCompatible: boolean;
}

export interface SwarmDecision {
  decision: string;
  confidence: number;
  participatingAgents: string[];
  consensusReached: boolean;
  timestamp: number;
}

export class AutonomousCoordinationManager extends EventEmitter {
  private agentId: string;
  private memoryManager: AutonomousMemoryManager;
  private knownAgents: Map<string, AgentStatus> = new Map();
  private activeTasks: Map<string, CoordinationTask> = new Map();
  private swarmDecisions: Map<string, SwarmDecision> = new Map();
  private coordinationInterval: NodeJS.Timeout;
  private heartbeatInterval: NodeJS.Timeout;

  constructor(agentId: string, memoryManager: AutonomousMemoryManager) {
    super();
    this.agentId = agentId;
    this.memoryManager = memoryManager;

    this.setupCoordinationLoop();
    this.setupHeartbeat();
    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Listen to memory manager coordination events
    this.memoryManager.on('coordination:received', (data) => {
      this.handlePeerCoordination(data);
    });

    // Listen to memory manager errors for resilience
    this.memoryManager.on('memory:error', (error) => {
      this.handleMemoryError(error);
    });
  }

  private setupCoordinationLoop(): void {
    // Main coordination loop - runs every 15 seconds
    this.coordinationInterval = setInterval(() => {
      this.autonomousCoordinationCycle();
    }, 15000);
  }

  private setupHeartbeat(): void {
    // Heartbeat to announce presence - every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      this.broadcastHeartbeat();
    }, 30000);
  }

  /**
   * Main autonomous coordination cycle
   */
  private async autonomousCoordinationCycle(): Promise<void> {
    try {
      // 1. Update agent status
      await this.updateAgentStatus();

      // 2. Discover and evaluate tasks
      await this.discoverTasks();

      // 3. Coordinate task assignment
      await this.coordinateTaskAssignment();

      // 4. Monitor task progress
      await this.monitorTasks();

      // 5. Make swarm decisions
      await this.makeSwarmDecisions();

      // 6. Clean up stale data
      await this.cleanupStaleData();

      this.emit('coordination:cycle:complete');
    } catch (error) {
      console.error(`[${this.agentId}] Coordination cycle error:`, error);
      this.emit('coordination:error', error);
    }
  }

  /**
   * Update this agent's status and broadcast it
   */
  private async updateAgentStatus(): Promise<void> {
    const status: AgentStatus = {
      agentId: this.agentId,
      status: this.determineCurrentStatus(),
      capabilities: this.getCapabilities(),
      load: this.calculateCurrentLoad(),
      lastSeen: Date.now(),
      location: {
        network: 'xmrt-mainnet',
        region: process.env.XMRT_REGION || 'global',
        meshNode: process.env.MESHNET_NODE_ID,
      },
    };

    // Store locally
    this.knownAgents.set(this.agentId, status);

    // Broadcast to network
    await this.memoryManager.storeMemory({
      agentId: this.agentId,
      type: 'coordination',
      content: { type: 'status_update', status },
      connections: [],
    });

    this.emit('status:updated', status);
  }

  /**
   * Discover new tasks that need coordination
   */
  private async discoverTasks(): Promise<void> {
    // Get recent coordination memories to discover tasks
    const memories = await this.memoryManager.retrieveMemories('task coordination', 20);
    
    for (const memory of memories) {
      if (memory.content?.type === 'task_request') {
        const task = memory.content.task as CoordinationTask;
        if (!this.activeTasks.has(task.id)) {
          this.activeTasks.set(task.id, task);
          this.emit('task:discovered', task);
        }
      }
    }

    // Generate autonomous tasks based on system needs
    await this.generateAutonomousTasks();
  }

  /**
   * Generate tasks autonomously based on system analysis
   */
  private async generateAutonomousTasks(): Promise<void> {
    const insights = await this.memoryManager.getLearningInsights();
    
    // Generate learning task if patterns are low
    if (insights.totalPatterns < 10) {
      const learningTask: CoordinationTask = {
        id: `learning:${Date.now()}`,
        type: 'learning',
        priority: 0.8,
        requiredCapabilities: ['learning', 'memory'],
        assignedAgents: [],
        status: 'pending',
        meshnetCompatible: true,
      };
      
      this.activeTasks.set(learningTask.id, learningTask);
      await this.broadcastTask(learningTask);
    }

    // Generate coordination task if agents are isolated
    if (this.knownAgents.size < 3) {
      const coordinationTask: CoordinationTask = {
        id: `coordination:${Date.now()}`,
        type: 'meshnet',
        priority: 0.9,
        requiredCapabilities: ['networking', 'coordination'],
        assignedAgents: [],
        status: 'pending',
        meshnetCompatible: true,
      };
      
      this.activeTasks.set(coordinationTask.id, coordinationTask);
      await this.broadcastTask(coordinationTask);
    }
  }

  /**
   * Coordinate task assignment among agents
   */
  private async coordinateTaskAssignment(): Promise<void> {
    for (const [taskId, task] of this.activeTasks.entries()) {
      if (task.status === 'pending' && task.assignedAgents.length === 0) {
        const suitableAgents = this.findSuitableAgents(task);
        
        if (suitableAgents.length > 0) {
          // Assign task to best agent(s)
          const assignedAgent = this.selectBestAgent(suitableAgents, task);
          task.assignedAgents = [assignedAgent.agentId];
          task.status = 'active';
          
          await this.notifyTaskAssignment(task, assignedAgent);
          this.emit('task:assigned', { task, agent: assignedAgent });
        }
      }
    }
  }

  /**
   * Monitor active task progress
   */
  private async monitorTasks(): Promise<void> {
    const now = Date.now();
    
    for (const [taskId, task] of this.activeTasks.entries()) {
      if (task.status === 'active') {
        // Check if task has deadline and is overdue
        if (task.deadline && now > task.deadline) {
          task.status = 'failed';
          await this.handleTaskFailure(task);
        }
        
        // Check if assigned agents are still active
        const activeAssignees = task.assignedAgents.filter(agentId => {
          const agent = this.knownAgents.get(agentId);
          return agent && (now - agent.lastSeen) < 60000; // 1 minute timeout
        });
        
        if (activeAssignees.length === 0) {
          // Reassign task
          task.assignedAgents = [];
          task.status = 'pending';
          this.emit('task:reassignment_needed', task);
        }
      }
    }
  }

  /**
   * Make swarm decisions using consensus
   */
  private async makeSwarmDecisions(): Promise<void> {
    // Collect decision proposals from memory
    const memories = await this.memoryManager.retrieveMemories('decision proposal', 10);
    const proposals = new Map<string, any[]>();
    
    for (const memory of memories) {
      if (memory.content?.type === 'decision_proposal') {
        const proposal = memory.content.proposal;
        if (!proposals.has(proposal)) {
          proposals.set(proposal, []);
        }
        proposals.get(proposal)!.push(memory);
      }
    }

    // Process each proposal for consensus
    for (const [proposal, votes] of proposals.entries()) {
      const decision = await this.processSwarmDecision(proposal, votes);
      if (decision.consensusReached) {
        this.swarmDecisions.set(proposal, decision);
        await this.implementSwarmDecision(decision);
        this.emit('swarm:decision', decision);
      }
    }
  }

  /**
   * Process a swarm decision using consensus algorithm
   */
  private async processSwarmDecision(proposal: string, votes: any[]): Promise<SwarmDecision> {
    const totalAgents = this.knownAgents.size;
    const requiredConsensus = Math.ceil(totalAgents * 0.6); // 60% consensus
    
    const supportVotes = votes.filter(vote => vote.content.support === true).length;
    const confidence = supportVotes / totalAgents;
    const consensusReached = supportVotes >= requiredConsensus;
    
    return {
      decision: proposal,
      confidence,
      participatingAgents: votes.map(v => v.agentId),
      consensusReached,
      timestamp: Date.now(),
    };
  }

  /**
   * Implement a swarm decision
   */
  private async implementSwarmDecision(decision: SwarmDecision): Promise<void> {
    // Store decision in memory
    await this.memoryManager.storeMemory({
      agentId: this.agentId,
      type: 'coordination',
      content: { type: 'swarm_decision', decision },
      connections: [],
    });

    // Take action based on decision
    if (decision.decision.includes('upgrade')) {
      this.emit('action:upgrade_required', decision);
    } else if (decision.decision.includes('coordinate')) {
      this.emit('action:coordinate_required', decision);
    } else if (decision.decision.includes('learn')) {
      this.emit('action:learning_required', decision);
    }
  }

  /**
   * Clean up stale data
   */
  private async cleanupStaleData(): Promise<void> {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes

    // Remove stale agents
    for (const [agentId, agent] of this.knownAgents.entries()) {
      if (now - agent.lastSeen > staleThreshold) {
        this.knownAgents.delete(agentId);
        this.emit('agent:offline', agent);
      }
    }

    // Clean up completed/failed tasks
    for (const [taskId, task] of this.activeTasks.entries()) {
      if (task.status === 'completed' || task.status === 'failed') {
        if (now - (task.deadline || 0) > staleThreshold) {
          this.activeTasks.delete(taskId);
        }
      }
    }
  }

  /**
   * Broadcast heartbeat to announce presence
   */
  private async broadcastHeartbeat(): Promise<void> {
    await this.memoryManager.storeMemory({
      agentId: this.agentId,
      type: 'coordination',
      content: { 
        type: 'heartbeat', 
        timestamp: Date.now(),
        capabilities: this.getCapabilities(),
        status: this.determineCurrentStatus(),
      },
      connections: [],
    });
  }

  /**
   * Handle coordination data from peer agents
   */
  private handlePeerCoordination(data: any): void {
    if (data.agentId && data.agentId !== this.agentId) {
      // Update known agent status
      const agentStatus: AgentStatus = {
        agentId: data.agentId,
        status: data.status || 'active',
        capabilities: data.capabilities || [],
        load: data.load || 0.5,
        lastSeen: Date.now(),
        location: data.location,
      };
      
      this.knownAgents.set(data.agentId, agentStatus);
      this.emit('agent:discovered', agentStatus);
    }
  }

  /**
   * Handle memory system errors gracefully
   */
  private handleMemoryError(error: any): void {
    console.warn(`[${this.agentId}] Memory error in coordination, switching to degraded mode:`, error);
    // Implement fallback coordination without Redis
    this.emit('coordination:degraded_mode', error);
  }

  /**
   * Determine current agent status
   */
  private determineCurrentStatus(): AgentStatus['status'] {
    // Simple status determination logic
    if (this.activeTasks.size > 3) return 'coordinating';
    if (this.activeTasks.size > 0) return 'active';
    return 'idle';
  }

  /**
   * Get agent capabilities
   */
  private getCapabilities(): string[] {
    return [
      'coordination',
      'learning',
      'memory',
      'autonomous',
      'meshnet',
      'privacy',
      'mining',
      'governance',
    ];
  }

  /**
   * Calculate current system load
   */
  private calculateCurrentLoad(): number {
    const maxTasks = 10;
    return Math.min(1, this.activeTasks.size / maxTasks);
  }

  /**
   * Find agents suitable for a task
   */
  private findSuitableAgents(task: CoordinationTask): AgentStatus[] {
    return Array.from(this.knownAgents.values()).filter(agent => {
      // Check capabilities
      const hasRequiredCapabilities = task.requiredCapabilities.every(cap =>
        agent.capabilities.includes(cap)
      );
      
      // Check availability
      const isAvailable = agent.status === 'idle' || agent.status === 'active';
      const hasCapacity = agent.load < 0.8;
      
      return hasRequiredCapabilities && isAvailable && hasCapacity;
    });
  }

  /**
   * Select best agent for a task
   */
  private selectBestAgent(candidates: AgentStatus[], task: CoordinationTask): AgentStatus {
    // Score agents based on suitability
    const scored = candidates.map(agent => ({
      agent,
      score: this.calculateAgentScore(agent, task),
    }));
    
    // Sort by score and return best
    scored.sort((a, b) => b.score - a.score);
    return scored[0].agent;
  }

  /**
   * Calculate agent suitability score for a task
   */
  private calculateAgentScore(agent: AgentStatus, task: CoordinationTask): number {
    let score = 0;
    
    // Capability match
    const capabilityMatch = task.requiredCapabilities.filter(cap =>
      agent.capabilities.includes(cap)
    ).length / task.requiredCapabilities.length;
    score += capabilityMatch * 0.4;
    
    // Load factor (prefer less loaded agents)
    score += (1 - agent.load) * 0.3;
    
    // Recency factor
    const recency = Math.max(0, 1 - (Date.now() - agent.lastSeen) / 60000);
    score += recency * 0.2;
    
    // Priority bonus
    score += task.priority * 0.1;
    
    return score;
  }

  /**
   * Broadcast a task to the network
   */
  private async broadcastTask(task: CoordinationTask): Promise<void> {
    await this.memoryManager.storeMemory({
      agentId: this.agentId,
      type: 'coordination',
      content: { type: 'task_request', task },
      connections: [],
    });
  }

  /**
   * Notify agent of task assignment
   */
  private async notifyTaskAssignment(task: CoordinationTask, agent: AgentStatus): Promise<void> {
    await this.memoryManager.storeMemory({
      agentId: this.agentId,
      type: 'coordination',
      content: { 
        type: 'task_assignment', 
        task, 
        assignedTo: agent.agentId,
        timestamp: Date.now(),
      },
      connections: [agent.agentId],
    });
  }

  /**
   * Handle task failure
   */
  private async handleTaskFailure(task: CoordinationTask): Promise<void> {
    await this.memoryManager.storeMemory({
      agentId: this.agentId,
      type: 'coordination',
      content: { 
        type: 'task_failure', 
        task,
        reason: 'deadline_exceeded',
        timestamp: Date.now(),
      },
      connections: task.assignedAgents,
    });
    
    this.emit('task:failed', task);
  }

  /**
   * Get coordination status for external monitoring
   */
  getCoordinationStatus(): {
    knownAgents: number;
    activeTasks: number;
    swarmDecisions: number;
    currentLoad: number;
  } {
    return {
      knownAgents: this.knownAgents.size,
      activeTasks: this.activeTasks.size,
      swarmDecisions: this.swarmDecisions.size,
      currentLoad: this.calculateCurrentLoad(),
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if (this.coordinationInterval) {
      clearInterval(this.coordinationInterval);
    }
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    this.emit('coordination:shutdown');
  }
}

