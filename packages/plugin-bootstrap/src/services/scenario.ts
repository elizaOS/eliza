import {
  type ActionEventPayload,
  ChannelType,
  type EvaluatorEventPayload,
  EventType,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  Service,
  type UUID,
  type World,
  createUniqueUuid,
  logger,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

/**
 * Interface representing an action tracker.
 * @typedef {Object} ActionTracker
 * @property {UUID} actionId - The unique identifier for the action.
 * @property {string} actionName - The name of the action.
 * @property {number} startTime - The starting time of the action.
 * @property {boolean} completed - Indicates whether the action has been completed.
 * @property {Error} [error] - Optional field for any error that occurred during the action.
 */
interface ActionTracker {
  actionId: UUID;
  actionName: string;
  startTime: number;
  completed: boolean;
  error?: Error;
}

/**
 * Interface representing an evaluator tracker.
 * @typedef {Object} EvaluatorTracker
 * @property {UUID} evaluatorId - The unique identifier of the evaluator.
 * @property {string} evaluatorName - The name of the evaluator.
 * @property {number} startTime - The start time of the evaluation process.
 * @property {boolean} completed - Indicates whether the evaluation process has been completed.
 * @property {Error} [error] - Optional error object if an error occurred during evaluation.
 */
interface EvaluatorTracker {
  evaluatorId: UUID;
  evaluatorName: string;
  startTime: number;
  completed: boolean;
  error?: Error;
}

/**
 * Represents a service that allows the agent to interact in a scenario testing environment.
 * The agent can Create groups, send messages, and communicate with other agents in a live interactive testing environment.
 * @extends Service
 */
/**
 * Represents a Scenario Service that allows the agent to interact in a scenario testing environment.
 * This service can Create groups, send messages, and communicate with other agents in a live interactive testing environment.
 */
export class ScenarioService extends Service {
  static serviceType = 'scenario';
  capabilityDescription =
    'The agent is currently in a scenario testing environment. It can Create groups, send messages, and talk to other agents in a live interactive testing environment.';
  private messageHandlers: Map<UUID, HandlerCallback[]> = new Map();
  private worlds: Map<UUID, World> = new Map();
  private activeActions: Map<UUID, ActionTracker> = new Map();
  private activeEvaluators: Map<UUID, EvaluatorTracker> = new Map();

  /**
   * Constructor for creating a new instance of the class.
   *
   * @param runtime - The IAgentRuntime instance to be passed to the constructor.
   */
  constructor(protected runtime: IAgentRuntime) {
    super(runtime);
    this.setupEventListeners();
  }

  private setupEventListeners() {
    // Track action start/completion
    this.runtime.registerEvent(EventType.ACTION_STARTED, async (data: ActionEventPayload) => {
      this.activeActions.set(data.actionId, {
        actionId: data.actionId,
        actionName: data.actionName,
        startTime: Date.now(),
        completed: false,
      });
      return Promise.resolve();
    });

    this.runtime.registerEvent(EventType.ACTION_COMPLETED, async (data: ActionEventPayload) => {
      const action = this.activeActions.get(data.actionId);
      if (action) {
        action.completed = true;
        action.error = data.error;
      }
      return Promise.resolve();
    });

    // Track evaluator start/completion
    this.runtime.registerEvent(EventType.EVALUATOR_STARTED, async (data: EvaluatorEventPayload) => {
      this.activeEvaluators.set(data.evaluatorId, {
        evaluatorId: data.evaluatorId,
        evaluatorName: data.evaluatorName,
        startTime: Date.now(),
        completed: false,
      });
      logger.debug('Evaluator started', data);
      return Promise.resolve();
    });

    this.runtime.registerEvent(
      EventType.EVALUATOR_COMPLETED,
      async (data: EvaluatorEventPayload) => {
        const evaluator = this.activeEvaluators.get(data.evaluatorId);
        if (evaluator) {
          evaluator.completed = true;
          evaluator.error = data.error;
        }
        logger.debug('Evaluator completed', data);
        return Promise.resolve();
      }
    );
  }

  /**
   * Start the scenario service with the given runtime.
   * @param {IAgentRuntime} runtime - The agent runtime
   * @returns {Promise<ScenarioService>} - The started scenario service
   */
  static async start(runtime: IAgentRuntime) {
    const service = new ScenarioService(runtime);
    return service;
  }

  /**
   * Stops the Scenario service associated with the given runtime.
   *
   * @param {IAgentRuntime} runtime The runtime to stop the service for.
   * @throws {Error} When the Scenario service is not found.
   */
  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService(ScenarioService.serviceType);
    if (!service) {
      throw new Error('Scenario service not found');
    }
    service.stop();
  }

  /**
   * Asynchronously stops the current process by clearing all message handlers and worlds.
   */
  async stop() {
    this.messageHandlers.clear();
    this.worlds.clear();
    this.activeActions.clear();
    this.activeEvaluators.clear();
  }

  /**
   * Creates a new world with the specified name and owner.
   * @param name The name of the world
   * @param ownerName The name of the world owner
   * @returns The created world's ID
   */
  async createWorld(name: string, ownerName: string): Promise<UUID> {
    const serverId = createUniqueUuid(this.runtime.agentId, name);
    const worldId = uuidv4() as UUID;
    const ownerId = uuidv4() as UUID;

    const world: World = {
      id: worldId,
      name,
      serverId,
      agentId: this.runtime.agentId,
      // TODO: get the server id, create it or whatever
      metadata: {
        // this is wrong, the owner needs to be tracked by scenario and similar to how we do it with Discord etc
        owner: {
          id: ownerId,
          name: ownerName,
        },
      },
    };

    this.worlds.set(worldId, world);
    return worldId;
  }

  /**
   * Creates a room in the specified world.
   * @param worldId The ID of the world to create the room in
   * @param name The name of the room
   * @returns The created room's ID
   */
  async createRoom(worldId: UUID, name: string): Promise<UUID> {
    const world = this.worlds.get(worldId);
    if (!world) {
      throw new Error(`World ${worldId} not found`);
    }

    const roomId = uuidv4() as UUID;

    // worlds do not have rooms on them, we'll need to use runtime.getRooms(worldId) from the runtime

    await this.runtime.ensureRoomExists({
      id: roomId,
      name,
      source: 'scenario',
      type: ChannelType.GROUP,
      channelId: roomId,
      serverId: worldId,
      worldId,
    });

    return roomId;
  }

  /**
   * Adds a participant to a room
   * @param worldId The world ID
   * @param roomId The room ID
   * @param participantId The participant's ID
   */
  async addParticipant(worldId: UUID, roomId: UUID, participantId: UUID) {
    const world = this.worlds.get(worldId);
    if (!world) {
      throw new Error(`World ${worldId} not found`);
    }

    const room = this.runtime.getRoom(roomId);
    if (!room) {
      throw new Error(`Room ${roomId} not found in world ${worldId}`);
    }

    await this.runtime.addParticipant(roomId, participantId);

    // TODO: This could all be rewritten like an ensureConnection approach
  }

  /**
   * Sends a message in a specific room
   * @param sender The runtime of the sending agent
   * @param worldId The world ID
   * @param roomId The room ID
   * @param text The message text
   */
  async sendMessage(sender: IAgentRuntime, worldId: UUID, roomId: UUID, text: string) {
    const world = this.worlds.get(worldId);
    if (!world) {
      throw new Error(`World ${worldId} not found`);
    }

    const memory: Memory = {
      entityId: sender.agentId,
      agentId: sender.agentId,
      roomId,
      content: {
        text,
        source: 'scenario',
        name: sender.character.name,
        userName: sender.character.name,
        channelType: ChannelType.GROUP,
      },
    };

    const participants = await this.runtime.getParticipantsForRoom(roomId);

    // Emit message received event for all participants
    for (const participantId of participants) {
      this.runtime.emitEvent('MESSAGE_RECEIVED', {
        runtime: this.runtime,
        message: memory,
        roomId,
        entityId: participantId,
        source: 'scenario',
        type: ChannelType.GROUP,
      });
    }
  }

  /**
   * Waits for all active actions and evaluators to complete
   * @param timeout Maximum time to wait in milliseconds
   * @returns True if all completed successfully, false if timeout occurred
   */
  async waitForCompletion(timeout = 30000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const allActionsComplete = Array.from(this.activeActions.values()).every(
        (action) => action.completed
      );
      const allEvaluatorsComplete = Array.from(this.activeEvaluators.values()).every(
        (evaluator) => evaluator.completed
      );

      if (allActionsComplete && allEvaluatorsComplete) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return false;
  }

  /**
   * Gets the current state of all active actions and evaluators
   */
  getActiveState() {
    return {
      actions: Array.from(this.activeActions.values()),
      evaluators: Array.from(this.activeEvaluators.values()),
    };
  }

  /**
   * Cleans up the scenario state
   */
  async cleanup() {
    this.worlds.clear();
    this.activeActions.clear();
    this.activeEvaluators.clear();
    this.messageHandlers.clear();
  }
}

// Updated scenario implementation using the new client
/**
 * An array of asynchronous functions representing different scenarios.
 *
 * @param {IAgentRuntime[]} members - The array of agent runtime objects.
 * @returns {Promise<void>} - A promise that resolves when the scenario is completed.
 */
const scenarios = [
  async function scenario1(members: IAgentRuntime[]) {
    const service = members[0].getService('scenario') as ScenarioService;
    if (!service) {
      throw new Error('Scenario service not found');
    }

    // Create a test world
    const worldId = await service.createWorld('Test Server', 'Test Owner');

    // Create groups for each member
    const roomIds: UUID[] = [];
    for (const member of members) {
      const roomId = await service.createRoom(worldId, `Test Room for ${member.character.name}`);
      roomIds.push(roomId);
      await service.addParticipant(worldId, roomId, member.agentId);
    }

    // Set up conversation history in the first room
    await service.sendMessage(
      members[0],
      worldId,
      roomIds[0],
      'Earlier message from conversation...'
    );

    // Send live message that triggers handlers
    await service.sendMessage(members[0], worldId, roomIds[0], 'Hello everyone!');
  },
];

/**
 * Asynchronously starts the specified scenario for the given list of agent runtimes.
 * @param {IAgentRuntime[]} members - The list of agent runtimes participating in the scenario.
 * @returns {Promise<void>} - A promise that resolves when all scenarios have been executed.
 */
export async function startScenario(members: IAgentRuntime[]) {
  for (const scenario of scenarios) {
    await scenario(members);
  }
}
