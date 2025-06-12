import type { HandlerCallback } from './components';
import type { Entity, Room, World } from './environment';
import type { Memory } from './memory';
import type { ModelTypeName } from './model';
import type { Metadata, UUID } from './primitives';
import type { IAgentRuntime } from './runtime';

/**
 * Standard event types across all platforms
 */
export enum EventType {
  // World events
  WORLD_JOINED = 'WORLD_JOINED',
  WORLD_CONNECTED = 'WORLD_CONNECTED',
  WORLD_LEFT = 'WORLD_LEFT',

  // Entity events
  ENTITY_JOINED = 'ENTITY_JOINED',
  ENTITY_LEFT = 'ENTITY_LEFT',
  ENTITY_UPDATED = 'ENTITY_UPDATED',

  // Room events
  ROOM_JOINED = 'ROOM_JOINED',
  ROOM_LEFT = 'ROOM_LEFT',

  // Message events
  MESSAGE_RECEIVED = 'MESSAGE_RECEIVED',
  MESSAGE_SENT = 'MESSAGE_SENT',
  MESSAGE_DELETED = 'MESSAGE_DELETED',

  // Channel events
  CHANNEL_CLEARED = 'CHANNEL_CLEARED',

  // Voice events
  VOICE_MESSAGE_RECEIVED = 'VOICE_MESSAGE_RECEIVED',
  VOICE_MESSAGE_SENT = 'VOICE_MESSAGE_SENT',

  // Interaction events
  REACTION_RECEIVED = 'REACTION_RECEIVED',
  POST_GENERATED = 'POST_GENERATED',
  INTERACTION_RECEIVED = 'INTERACTION_RECEIVED',

  // Run events
  RUN_STARTED = 'RUN_STARTED',
  RUN_ENDED = 'RUN_ENDED',
  RUN_TIMEOUT = 'RUN_TIMEOUT',

  // Action events
  ACTION_STARTED = 'ACTION_STARTED',
  ACTION_COMPLETED = 'ACTION_COMPLETED',

  // Evaluator events
  EVALUATOR_STARTED = 'EVALUATOR_STARTED',
  EVALUATOR_COMPLETED = 'EVALUATOR_COMPLETED',

  // Model events
  MODEL_USED = 'MODEL_USED',
}

/**
 * Platform-specific event type prefix
 */
export enum PlatformPrefix {
  DISCORD = 'DISCORD',
  TELEGRAM = 'TELEGRAM',
  TWITTER = 'TWITTER',
}

/**
 * Base payload interface for all events
 */
export interface EventPayload {
  runtime: IAgentRuntime;
  source: string;
  onComplete?: () => void;
}

/**
 * Payload for world-related events
 */
export interface WorldPayload extends EventPayload {
  world: World;
  rooms: Room[];
  entities: Entity[];
}

/**
 * Payload for entity-related events
 */
export interface EntityPayload extends EventPayload {
  entityId: UUID;
  worldId?: UUID;
  roomId?: UUID;
  metadata?: {
    orginalId: string;
    username: string;
    displayName?: string;
    [key: string]: any;
  };
}

/**
 * Payload for reaction-related events
 */
export interface MessagePayload extends EventPayload {
  message: Memory;
  callback?: HandlerCallback;
  onComplete?: () => void;
}

/**
 * Payload for channel cleared events
 */
export interface ChannelClearedPayload extends EventPayload {
  roomId: UUID;
  channelId: string;
  memoryCount: number;
}

/**
 * Payload for events that are invoked without a message
 */
export interface InvokePayload extends EventPayload {
  worldId: UUID;
  userId: string;
  roomId: UUID;
  callback?: HandlerCallback;
  source: string;
}

/**
 * Run event payload type
 */
export interface RunEventPayload extends EventPayload {
  runId: UUID;
  messageId: UUID;
  roomId: UUID;
  entityId: UUID;
  startTime: number;
  status: 'started' | 'completed' | 'timeout';
  endTime?: number;
  duration?: number;
  error?: string;
}

/**
 * Action event payload type
 */
export interface ActionEventPayload extends EventPayload {
  actionId: UUID;
  actionName: string;
  startTime?: number;
  completed?: boolean;
  error?: Error;
}

/**
 * Evaluator event payload type
 */
export interface EvaluatorEventPayload extends EventPayload {
  evaluatorId: UUID;
  evaluatorName: string;
  startTime?: number;
  completed?: boolean;
  error?: Error;
}

/**
 * Model event payload type
 */
export interface ModelEventPayload extends EventPayload {
  provider: string;
  type: ModelTypeName;
  prompt: string;
  tokens?: {
    prompt: number;
    completion: number;
    total: number;
  };
}

export type MessageReceivedHandlerParams = {
  runtime: IAgentRuntime;
  message: Memory;
  callback: HandlerCallback;
  onComplete?: () => void;
};

/**
 * Maps event types to their corresponding payload types
 */
export interface EventPayloadMap {
  [EventType.WORLD_JOINED]: WorldPayload;
  [EventType.WORLD_CONNECTED]: WorldPayload;
  [EventType.WORLD_LEFT]: WorldPayload;
  [EventType.ENTITY_JOINED]: EntityPayload;
  [EventType.ENTITY_LEFT]: EntityPayload;
  [EventType.ENTITY_UPDATED]: EntityPayload;
  [EventType.MESSAGE_RECEIVED]: MessagePayload;
  [EventType.MESSAGE_SENT]: MessagePayload;
  [EventType.MESSAGE_DELETED]: MessagePayload;
  [EventType.CHANNEL_CLEARED]: ChannelClearedPayload;
  [EventType.REACTION_RECEIVED]: MessagePayload;
  [EventType.POST_GENERATED]: InvokePayload;
  [EventType.INTERACTION_RECEIVED]: MessagePayload;
  [EventType.RUN_STARTED]: RunEventPayload;
  [EventType.RUN_ENDED]: RunEventPayload;
  [EventType.RUN_TIMEOUT]: RunEventPayload;
  [EventType.ACTION_STARTED]: ActionEventPayload;
  [EventType.ACTION_COMPLETED]: ActionEventPayload;
  [EventType.EVALUATOR_STARTED]: EvaluatorEventPayload;
  [EventType.EVALUATOR_COMPLETED]: EvaluatorEventPayload;
  [EventType.MODEL_USED]: ModelEventPayload;
}

/**
 * Event handler function type
 */
export type EventHandler<T extends keyof EventPayloadMap> = (
  payload: EventPayloadMap[T]
) => Promise<void>;

/**
 * Defines a more specific type for event handlers, expecting an `Metadata`.
 * This aims to improve upon generic 'any' type handlers, providing a clearer contract
 * for functions that respond to events emitted within the agent runtime (see `emitEvent` in `AgentRuntime`).
 * Handlers can be synchronous or asynchronous.
 */
export type TypedEventHandler = (data: Metadata) => Promise<void> | void;
