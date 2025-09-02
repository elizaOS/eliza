import {
  type Character,
  type IAgentRuntime,
  type Plugin,
  type UUID,
} from '@elizaos/core';
import { AgentServer } from '../index';
import { AgentManager } from '../managers/AgentManager';
import { ConfigManager } from '../managers/ConfigManager';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ElizaOSConfig {
  port?: number;
  dataDir?: string;
  postgresUrl?: string;
  characters?: Character[];
  plugins?: (Plugin | string)[];
}

export class ElizaOS {
  private server: AgentServer;
  private agentManager: AgentManager;
  private configManager: ConfigManager;
  private config: ElizaOSConfig;
  private agents: Map<UUID, IAgentRuntime> = new Map();

  constructor(config: ElizaOSConfig = {}) {
    this.config = config;
    this.server = new AgentServer();
    this.agentManager = new AgentManager(this.server);
    this.configManager = new ConfigManager();
  }

  /**
   * Initialize ElizaOS with all required services
   */
  private async initialize(): Promise<void> {
    // Initialize server with database (AgentServer handles everything)
    await this.server.initialize({
      dataDir: this.config.dataDir,
      postgresUrl: this.config.postgresUrl,
    });

    // Load environment configuration
    await this.configManager.loadEnvConfig();

    // Setup agent lifecycle methods on server
    this.server.startAgent = async (character: Character) => {
      return this.agentManager.startAgent(character);
    };
    this.server.stopAgent = async (runtime: IAgentRuntime) => {
      await this.agentManager.stopAgent(runtime);
    };
  }

  /**
   * Start ElizaOS with configured characters or default
   */
  async start(): Promise<void> {
    await this.initialize();

    const port = this.config.port ?? Number.parseInt(process.env.SERVER_PORT ?? '3000', 10);
    await this.server.start(port);

    // Start configured characters
    if (this.config.characters && this.config.characters.length > 0) {
      for (const character of this.config.characters) {
        const runtime = await this.startWithCharacter(character);
        this.agents.set(runtime.agentId, runtime);
      }
    } else {
      // Start with default Eliza character
      await this.startDefault();
    }
  }

  /**
   * Start with a specific character
   */
  async startWithCharacter(
    character: Character,
    init?: (runtime: IAgentRuntime) => Promise<void>,
    plugins?: (Plugin | string)[]
  ): Promise<IAgentRuntime> {
    if (!this.server.isInitialized) {
      await this.initialize();
      const port = this.config.port ?? Number.parseInt(process.env.SERVER_PORT ?? '3000', 10);
      await this.server.start(port);
    }

    const runtime = await this.agentManager.startAgent(
      character,
      init,
      plugins || this.config.plugins || []
    );
    this.agents.set(runtime.agentId, runtime);
    return runtime;
  }

  /**
   * Start from a character file path
   */
  async startFromFile(characterPath: string): Promise<IAgentRuntime> {
    const resolvedPath = path.resolve(characterPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Character file not found: ${resolvedPath}`);
    }

    const { loadCharacterTryPath } = await import('../loader');
    const character = await loadCharacterTryPath(resolvedPath);
    if (!character) {
      throw new Error(`Invalid character file: ${resolvedPath}`);
    }

    return this.startWithCharacter(character);
  }

  /**
   * Start with default Eliza character
   */
  async startDefault(): Promise<IAgentRuntime> {
    const { getDefaultCharacter } = await import('../characters/default');
    const elizaCharacter = getDefaultCharacter();
    return this.startWithCharacter(elizaCharacter);
  }

  /**
   * Stop a specific agent
   */
  async stopAgent(agentId: UUID): Promise<void> {
    const runtime = this.agents.get(agentId);
    if (runtime) {
      await this.agentManager.stopAgent(runtime);
      this.agents.delete(agentId);
    }
  }

  /**
   * Stop all agents and shutdown
   */
  async stop(): Promise<void> {
    // Stop all agents
    for (const [agentId, runtime] of this.agents) {
      await this.agentManager.stopAgent(runtime);
      this.agents.delete(agentId);
    }

    // Stop server
    await this.server.stop();
  }

  /**
   * Get server instance
   */
  getServer(): AgentServer {
    return this.server;
  }

  /**
   * Get all running agents
   */
  getAgents(): Map<UUID, IAgentRuntime> {
    return this.agents;
  }
}