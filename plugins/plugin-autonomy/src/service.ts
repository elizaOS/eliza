import {
  createUniqueUuid,
  Service,
  type Entity,
  type IAgentRuntime,
  type Memory,
  type ServiceTypeName,
} from '@elizaos/core';
import { EventType, AutonomousServiceType } from './types';

const AUTO_WORLD_SEED = 'autonomous_world_singleton';
const AUTO_ROOM_SEED = 'autonomous_room_singleton';
const COPILOT_ENTITY_SEED = 'autonomous_copilot_singleton';

export default class AutonomousService extends Service {
  static serviceType: string = AutonomousServiceType.AUTONOMOUS;
  capabilityDescription = 'Autonomous agent service, maintains the autonomous agent loop';

  private loopTimeout: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  async stop(): Promise<void> {
    console.log('[AutonomousService] Stopping autonomous loop...');
    this.isRunning = false;
    if (this.loopTimeout) {
      clearTimeout(this.loopTimeout);
      this.loopTimeout = null;
    }
    console.log('[AutonomousService] Autonomous loop stopped');
    return;
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    console.log('[AutonomousService] Starting autonomous service...');
    const autoService = new AutonomousService(runtime);
    return autoService;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(AutonomousService.serviceType) as AutonomousService;
    if (service) {
      await service.stop();
    }
    return;
  }

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.runtime = runtime;

    this.setupWorld().then(() => {
      this.isRunning = true;
      this.loop();
    });
  }

  async setupWorld() {
    const worldId = createUniqueUuid(this.runtime, AUTO_WORLD_SEED);
    this.runtime.setSetting('WORLD_ID', worldId);
    console.log(`[AutonomousService] Ensured WORLD_ID is set to: ${worldId}`);

    const world = await this.runtime.getWorld(worldId);

    const copilotEntityId = createUniqueUuid(this.runtime, COPILOT_ENTITY_SEED);

    const entityExists = await this.runtime.getEntityById(copilotEntityId);

    if (!entityExists) {
      const copilot: Entity = {
        id: copilotEntityId,
        names: ['Copilot'],
        agentId: this.runtime.agentId,
      };

      await this.runtime.createEntity(copilot);
    }

    if (!world) {
      await this.runtime.createWorld({
        id: worldId,
        name: 'Auto',
        agentId: this.runtime.agentId,
        serverId: worldId,
      });
    }
  }

  async loop() {
    // Check if we should stop
    if (!this.isRunning) {
      return;
    }

    console.log('*** loop');

    const copilotEntityId = createUniqueUuid(this.runtime, COPILOT_ENTITY_SEED);
    const worldId = this.runtime.getSetting('WORLD_ID') as ReturnType<typeof createUniqueUuid>;
    const roomId = createUniqueUuid(this.runtime, AUTO_ROOM_SEED);

    const autoPrompts = [
      'What should I do next? Think, plan and act.',
      'Next action. Go!',
      'What is your immediate next step? Execute.',
      'Proceed with the current plan. What is next?',
      "Don't stop now. What's the next move?",
      'Keep the momentum. What action follows?',
      'Time to act. What will you do?',
      'Focus and execute. What is the priority task?',
      'Advance your goals. What is the next logical step?',
      'Continue your work. What needs to be done now?',
      'Push forward. What is the next objective?',
    ];

    const newMessage: Memory = {
      id: createUniqueUuid(this.runtime, `auto-msg-${Date.now()}`),
      agentId: this.runtime.agentId,
      createdAt: Date.now(),
      content: {
        text: autoPrompts[Math.floor(Math.random() * autoPrompts.length)],
        type: 'text',
        source: 'auto',
      },
      roomId: roomId,
      worldId: worldId,
      entityId: copilotEntityId,
    };

    await this.runtime.emitEvent(EventType.AUTO_MESSAGE_RECEIVED, {
      runtime: this.runtime,
      message: newMessage,
      callback: (content) => {
        console.log('AUTO_MESSAGE_RECEIVED:\n', content);
      },
      onComplete: () => {
        console.log('AUTO_MESSAGE_RECEIVED COMPLETE');

        // Check again before scheduling next loop
        if (!this.isRunning) {
          return;
        }

        const interval = this.runtime.getSetting('AUTONOMOUS_LOOP_INTERVAL') || 1000;
        this.loopTimeout = setTimeout(async () => {
          this.loop();
        }, interval);
      },
    });
  }
}
