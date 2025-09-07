/**
 * Autonomous Memory Manager for XMRT-Eliza
 * Implements persistent memory and learning capabilities as described in DevGruGold's architecture
 */

import Redis from 'ioredis';
import { EventEmitter } from 'events';

export interface MemoryEntry {
  id: string;
  agentId: string;
  type: 'experience' | 'learning' | 'coordination' | 'feedback';
  content: any;
  timestamp: number;
  importance: number; // 0-1 scale
  connections: string[]; // IDs of related memories
}

export interface LearningPattern {
  pattern: string;
  confidence: number;
  occurrences: number;
  lastSeen: number;
  adaptations: string[];
}

export class AutonomousMemoryManager extends EventEmitter {
  private redis: Redis;
  private agentId: string;
  private memoryCache: Map<string, MemoryEntry> = new Map();
  private learningPatterns: Map<string, LearningPattern> = new Map();
  private coordinationChannels: Set<string> = new Set();

  constructor(agentId: string, redisConfig?: any) {
    super();
    this.agentId = agentId;
    
    // Initialize Redis connection for persistent memory
    this.redis = new Redis(redisConfig || {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      retryDelayOnFailover: 100,
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    });

    this.setupEventHandlers();
    this.initializeAutonomousLearning();
  }

  private setupEventHandlers(): void {
    this.redis.on('connect', () => {
      console.log(`[${this.agentId}] Memory system connected to Redis`);
      this.emit('memory:connected');
    });

    this.redis.on('error', (error) => {
      console.error(`[${this.agentId}] Memory system error:`, error);
      this.emit('memory:error', error);
    });

    // Subscribe to coordination channels
    this.redis.subscribe(`coordination:${this.agentId}`, 'coordination:broadcast');
    this.redis.on('message', (channel, message) => {
      this.handleCoordinationMessage(channel, message);
    });
  }

  private async initializeAutonomousLearning(): Promise<void> {
    // Load existing learning patterns
    const patterns = await this.redis.hgetall(`learning:patterns:${this.agentId}`);
    for (const [key, value] of Object.entries(patterns)) {
      this.learningPatterns.set(key, JSON.parse(value));
    }

    // Start autonomous learning loop
    setInterval(() => {
      this.autonomousLearningCycle();
    }, 30000); // Every 30 seconds
  }

  /**
   * Store a memory entry with autonomous importance scoring
   */
  async storeMemory(entry: Omit<MemoryEntry, 'id' | 'timestamp' | 'importance'>): Promise<string> {
    const memoryId = `memory:${this.agentId}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
    
    const fullEntry: MemoryEntry = {
      ...entry,
      id: memoryId,
      timestamp: Date.now(),
      importance: this.calculateImportance(entry),
    };

    // Store in Redis for persistence
    await this.redis.hset(`memories:${this.agentId}`, memoryId, JSON.stringify(fullEntry));
    
    // Cache locally for quick access
    this.memoryCache.set(memoryId, fullEntry);

    // Trigger learning from this memory
    this.learnFromMemory(fullEntry);

    this.emit('memory:stored', fullEntry);
    return memoryId;
  }

  /**
   * Retrieve memories with autonomous relevance scoring
   */
  async retrieveMemories(query: string, limit: number = 10): Promise<MemoryEntry[]> {
    const allMemories = await this.redis.hgetall(`memories:${this.agentId}`);
    const memories: MemoryEntry[] = Object.values(allMemories).map(m => JSON.parse(m));

    // Autonomous relevance scoring
    const scoredMemories = memories.map(memory => ({
      memory,
      relevance: this.calculateRelevance(memory, query),
    }));

    // Sort by relevance and importance
    scoredMemories.sort((a, b) => {
      const scoreA = a.relevance * a.memory.importance;
      const scoreB = b.relevance * b.memory.importance;
      return scoreB - scoreA;
    });

    return scoredMemories.slice(0, limit).map(sm => sm.memory);
  }

  /**
   * Autonomous learning cycle - runs continuously
   */
  private async autonomousLearningCycle(): Promise<void> {
    try {
      // Analyze recent memories for patterns
      const recentMemories = await this.getRecentMemories(100);
      
      for (const memory of recentMemories) {
        this.identifyPatterns(memory);
      }

      // Update learning patterns
      await this.persistLearningPatterns();

      // Coordinate with other agents
      await this.coordinateWithPeers();

      this.emit('learning:cycle:complete');
    } catch (error) {
      console.error(`[${this.agentId}] Autonomous learning cycle error:`, error);
      this.emit('learning:error', error);
    }
  }

  /**
   * Calculate importance of a memory entry autonomously
   */
  private calculateImportance(entry: Omit<MemoryEntry, 'id' | 'timestamp' | 'importance'>): number {
    let importance = 0.5; // Base importance

    // Type-based importance
    const typeWeights = {
      'experience': 0.7,
      'learning': 0.9,
      'coordination': 0.8,
      'feedback': 0.6,
    };
    importance *= typeWeights[entry.type] || 0.5;

    // Content-based importance (simplified)
    if (typeof entry.content === 'string') {
      const keywords = ['error', 'success', 'learn', 'improve', 'coordinate'];
      const keywordCount = keywords.filter(kw => 
        entry.content.toLowerCase().includes(kw)
      ).length;
      importance += keywordCount * 0.1;
    }

    // Connection-based importance
    importance += entry.connections.length * 0.05;

    return Math.min(1, Math.max(0, importance));
  }

  /**
   * Calculate relevance of a memory to a query
   */
  private calculateRelevance(memory: MemoryEntry, query: string): number {
    const queryLower = query.toLowerCase();
    let relevance = 0;

    // Content matching
    if (typeof memory.content === 'string') {
      const contentLower = memory.content.toLowerCase();
      if (contentLower.includes(queryLower)) {
        relevance += 0.8;
      }
      
      // Fuzzy matching (simplified)
      const queryWords = queryLower.split(' ');
      const matchingWords = queryWords.filter(word => 
        contentLower.includes(word)
      ).length;
      relevance += (matchingWords / queryWords.length) * 0.5;
    }

    // Type relevance
    if (memory.type === 'learning' && queryLower.includes('learn')) {
      relevance += 0.3;
    }

    // Recency factor
    const age = Date.now() - memory.timestamp;
    const recencyFactor = Math.exp(-age / (24 * 60 * 60 * 1000)); // Decay over 24 hours
    relevance *= (0.5 + 0.5 * recencyFactor);

    return Math.min(1, relevance);
  }

  /**
   * Learn from a memory entry by identifying patterns
   */
  private learnFromMemory(memory: MemoryEntry): void {
    if (typeof memory.content === 'string') {
      this.identifyPatterns(memory);
    }
  }

  /**
   * Identify patterns in memory content
   */
  private identifyPatterns(memory: MemoryEntry): void {
    if (typeof memory.content !== 'string') return;

    const content = memory.content.toLowerCase();
    
    // Simple pattern identification (can be enhanced with ML)
    const patterns = [
      /error.*(\w+)/g,
      /success.*(\w+)/g,
      /user.*wants.*(\w+)/g,
      /coordinate.*with.*(\w+)/g,
    ];

    patterns.forEach(pattern => {
      const matches = content.match(pattern);
      if (matches) {
        matches.forEach(match => {
          this.updateLearningPattern(match, memory);
        });
      }
    });
  }

  /**
   * Update learning patterns based on new observations
   */
  private updateLearningPattern(pattern: string, memory: MemoryEntry): void {
    const existing = this.learningPatterns.get(pattern);
    
    if (existing) {
      existing.occurrences++;
      existing.lastSeen = memory.timestamp;
      existing.confidence = Math.min(1, existing.confidence + 0.1);
    } else {
      this.learningPatterns.set(pattern, {
        pattern,
        confidence: 0.3,
        occurrences: 1,
        lastSeen: memory.timestamp,
        adaptations: [],
      });
    }
  }

  /**
   * Persist learning patterns to Redis
   */
  private async persistLearningPatterns(): Promise<void> {
    const patternsObj: Record<string, string> = {};
    
    for (const [key, pattern] of this.learningPatterns.entries()) {
      patternsObj[key] = JSON.stringify(pattern);
    }

    await this.redis.hset(`learning:patterns:${this.agentId}`, patternsObj);
  }

  /**
   * Coordinate with peer agents
   */
  private async coordinateWithPeers(): Promise<void> {
    const coordinationData = {
      agentId: this.agentId,
      timestamp: Date.now(),
      learningPatterns: Array.from(this.learningPatterns.entries()).slice(0, 5), // Top 5 patterns
      memoryCount: this.memoryCache.size,
      status: 'active',
    };

    await this.redis.publish('coordination:broadcast', JSON.stringify(coordinationData));
  }

  /**
   * Handle coordination messages from other agents
   */
  private handleCoordinationMessage(channel: string, message: string): void {
    try {
      const data = JSON.parse(message);
      
      if (data.agentId !== this.agentId) {
        // Learn from peer agent patterns
        if (data.learningPatterns) {
          data.learningPatterns.forEach(([pattern, patternData]: [string, LearningPattern]) => {
            const existing = this.learningPatterns.get(pattern);
            if (!existing || existing.confidence < patternData.confidence) {
              // Adopt or update pattern from peer
              this.learningPatterns.set(pattern, {
                ...patternData,
                adaptations: [...(existing?.adaptations || []), `learned_from_${data.agentId}`],
              });
            }
          });
        }

        this.emit('coordination:received', data);
      }
    } catch (error) {
      console.error(`[${this.agentId}] Error handling coordination message:`, error);
    }
  }

  /**
   * Get recent memories for analysis
   */
  private async getRecentMemories(limit: number): Promise<MemoryEntry[]> {
    const allMemories = await this.redis.hgetall(`memories:${this.agentId}`);
    const memories: MemoryEntry[] = Object.values(allMemories).map(m => JSON.parse(m));
    
    return memories
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Get learning insights for external systems
   */
  async getLearningInsights(): Promise<{
    totalPatterns: number;
    topPatterns: LearningPattern[];
    memoryCount: number;
    lastLearningActivity: number;
  }> {
    const patterns = Array.from(this.learningPatterns.values());
    
    return {
      totalPatterns: patterns.length,
      topPatterns: patterns
        .sort((a, b) => b.confidence * b.occurrences - a.confidence * a.occurrences)
        .slice(0, 10),
      memoryCount: this.memoryCache.size,
      lastLearningActivity: Math.max(...patterns.map(p => p.lastSeen), 0),
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    await this.persistLearningPatterns();
    await this.redis.quit();
    this.emit('memory:shutdown');
  }
}

