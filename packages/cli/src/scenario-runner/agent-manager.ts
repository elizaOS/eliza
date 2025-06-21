import {
  type IAgentRuntime,
  type UUID,
  type Memory,
  type Character,
  logger,
  asUUID,
  type Action,
  type State,
  type HandlerCallback,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
import type { ScenarioActor } from './types.js';

export interface AgentInstance {
  actor: ScenarioActor;
  runtime: IAgentRuntime;
  messageQueue: Memory[];
  actionHistory: Array<{
    timestamp: number;
    action: string;
    params: any;
    result: any;
  }>;
}

export class AgentManager {
  private agents = new Map<UUID, AgentInstance>();
  private messageRouter: MessageRouter;
  private agentMessageStore = new Map<UUID, Memory[]>();

  constructor(private primaryRuntime: IAgentRuntime) {
    this.messageRouter = new MessageRouter();
  }

  private getAgentMessages(agentId: UUID): Memory[] {
    if (!this.agentMessageStore.has(agentId)) {
      this.agentMessageStore.set(agentId, []);
    }
    return this.agentMessageStore.get(agentId)!;
  }

  async createAgentForActor(
    actor: ScenarioActor,
    worldId: UUID,
    roomId: UUID
  ): Promise<IAgentRuntime> {
    logger.info(`Creating isolated runtime for actor ${actor.name} (${actor.id})`);

    // Create a unique character for this actor
    const character: Character = {
      id: actor.id,
      name: actor.name,
      bio: actor.personality?.traits || ['An actor in a scenario'],
      system: actor.personality?.systemPrompt || this.primaryRuntime.character.system,
      messageExamples: [],
      postExamples: [],
      topics: actor.personality?.interests || [],
      adjectives: actor.personality?.traits || [],
      knowledge: actor.knowledge || [],
      plugins: this.primaryRuntime.character.plugins || [],
      settings: {
        ...this.primaryRuntime.character.settings,
        ...actor.settings,
      },
    };

    // Create isolated runtime with its own memory and services
    const runtime = await this.createIsolatedRuntime(character, worldId, roomId);

    // Store the agent instance
    const instance: AgentInstance = {
      actor,
      runtime,
      messageQueue: [],
      actionHistory: [],
    };

    this.agents.set(actor.id, instance);

    // Set up message routing
    this.messageRouter.registerAgent(actor.id, runtime);

    return runtime;
  }

  private async createIsolatedRuntime(
    character: Character,
    worldId: UUID,
    _roomId: UUID
  ): Promise<IAgentRuntime> {
    // Create a proxy runtime that isolates memory and services
    const agentId = asUUID(uuidv4());
    const messages = this.getAgentMessages(agentId);

    // Create a minimal runtime that extends the primary runtime
    const isolatedRuntime = Object.create(this.primaryRuntime);

    // Override specific properties
    isolatedRuntime.agentId = agentId;
    isolatedRuntime.character = character;

    // Override memory operations to be isolated
    isolatedRuntime.createMemory = async (memory: Memory): Promise<void> => {
      messages.push({ ...memory, agentId });
    };

    isolatedRuntime.getMemories = async (params: any) => {
      return messages
        .filter(
          (m: Memory) =>
            (!params.roomId || m.roomId === params.roomId) &&
            (!params.agentId || m.agentId === params.agentId)
        )
        .slice(0, params.count || params.limit || 50);
    };

    isolatedRuntime.updateMemory = async (memory: Partial<Memory> & { id: UUID }) => {
      const index = messages.findIndex((m: Memory) => m.id === memory.id);
      if (index >= 0) {
        messages[index] = { ...messages[index], ...memory };
        return true;
      }
      return false;
    };

    isolatedRuntime.deleteMemory = async (id: UUID): Promise<void> => {
      const index = messages.findIndex((m: Memory) => m.id === id);
      if (index >= 0) {
        messages.splice(index, 1);
      }
    };

    isolatedRuntime.searchMemories = async (params: any) => {
      const query = params.query?.toLowerCase() || '';
      return messages.filter((m: Memory) => m.content.text?.toLowerCase().includes(query));
    };

    // Override composeState to use isolated memory
    isolatedRuntime.composeState = async (message: Memory) => {
      const memories = await isolatedRuntime.getMemories({
        roomId: message.roomId,
        agentId: isolatedRuntime.agentId,
        count: 50,
      });

      return {
        values: {
          agentName: character.name,
          roomId: message.roomId,
          worldId,
        },
        data: {
          memories,
          character,
        },
        text: memories.map((m: Memory) => m.content.text).join('\n'),
      };
    };

    // Override processActions to track action execution
    if (isolatedRuntime.processActions) {
      const originalProcessActions = isolatedRuntime.processActions.bind(isolatedRuntime);
      isolatedRuntime.processActions = async (
        message: Memory,
        responses: Memory[],
        state?: State,
        callback?: HandlerCallback
      ) => {
        // Track action execution
        const actions = message.content.actions || [];
        for (const actionName of actions) {
          const action = isolatedRuntime.actions?.find((a: Action) => a.name === actionName);
          if (action) {
            const result = await originalProcessActions(message, responses, state, callback);
            this.agents.get(agentId)?.actionHistory.push({
              timestamp: Date.now(),
              action: action.name,
              params: { message: message.content.text },
              result,
            });
          }
        }
      };
    }

    return isolatedRuntime;
  }

  async routeMessage(fromActorId: UUID, toActorId: UUID | 'all', message: Memory): Promise<void> {
    if (toActorId === 'all') {
      // Broadcast to all agents
      for (const [actorId, agent] of this.agents) {
        if (actorId !== fromActorId) {
          agent.messageQueue.push(message);
        }
      }
    } else {
      // Direct message
      const targetAgent = this.agents.get(toActorId);
      if (targetAgent) {
        targetAgent.messageQueue.push(message);
      }
    }
  }

  async executeAction(actorId: UUID, actionName: string, params: any): Promise<any> {
    const agent = this.agents.get(actorId);
    if (!agent) {
      throw new Error(`Agent ${actorId} not found`);
    }

    const action = agent.runtime.actions.find((a) => a.name === actionName);
    if (!action) {
      throw new Error(`Action ${actionName} not found for agent ${actorId}`);
    }

    // Create a synthetic message for the action
    const message: Memory = {
      id: asUUID(uuidv4()),
      entityId: actorId,
      agentId: agent.runtime.agentId,
      roomId: params.roomId || asUUID(uuidv4()),
      content: {
        text: params.text || `Execute ${actionName}`,
        actions: [actionName],
        ...params,
      },
      createdAt: Date.now(),
    };

    const state = await agent.runtime.composeState(message);

    if (!(await action.validate(agent.runtime, message, state))) {
      throw new Error(`Action ${actionName} validation failed`);
    }

    const result = await action.handler(agent.runtime, message, state, params, async (response) => {
      logger.info(`Action ${actionName} response:`, response);
      return [];
    });

    // Record in history
    agent.actionHistory.push({
      timestamp: Date.now(),
      action: actionName,
      params,
      result,
    });

    return result;
  }

  getAgent(actorId: UUID): AgentInstance | undefined {
    return this.agents.get(actorId);
  }

  getAllAgents(): AgentInstance[] {
    return Array.from(this.agents.values());
  }

  getActionHistory(actorId?: UUID): any[] {
    if (actorId) {
      return this.agents.get(actorId)?.actionHistory || [];
    }

    // Return all action history
    const allHistory: any[] = [];
    for (const agent of this.agents.values()) {
      allHistory.push(
        ...agent.actionHistory.map((h) => ({
          ...h,
          actorId: agent.actor.id,
          actorName: agent.actor.name,
        }))
      );
    }
    return allHistory.sort((a, b) => a.timestamp - b.timestamp);
  }

  async cleanup(): Promise<void> {
    // Stop all services
    for (const agent of this.agents.values()) {
      for (const [_, service] of agent.runtime.services) {
        await service.stop();
      }
    }

    this.agents.clear();
  }
}

class MessageRouter {
  private routes = new Map<UUID, IAgentRuntime>();

  registerAgent(actorId: UUID, runtime: IAgentRuntime): void {
    this.routes.set(actorId, runtime);
  }

  async routeMessage(from: UUID, to: UUID | 'all', message: Memory): Promise<void> {
    if (to === 'all') {
      for (const [actorId, runtime] of this.routes) {
        if (actorId !== from) {
          await (runtime as any).messageManager.createMemory(message);
        }
      }
    } else {
      const runtime = this.routes.get(to);
      if (runtime) {
        await (runtime as any).messageManager.createMemory(message);
      }
    }
  }
}
