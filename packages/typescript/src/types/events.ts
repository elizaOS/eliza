import type { HandlerCallback } from "./components";
import type { Entity, Room, World } from "./environment";
import type { Memory } from "./memory";
import type { ControlMessage } from "./messaging";
import type { ModelTypeName } from "./model";
import type { Content, JsonValue, UUID } from "./primitives";
import type { IAgentRuntime } from "./runtime";

/**
 * Standard event types across all platforms
 */
export enum EventType {
  // World events
  WORLD_JOINED = "WORLD_JOINED",
  WORLD_CONNECTED = "WORLD_CONNECTED",
  WORLD_LEFT = "WORLD_LEFT",

  // Entity events
  ENTITY_JOINED = "ENTITY_JOINED",
  ENTITY_LEFT = "ENTITY_LEFT",
  ENTITY_UPDATED = "ENTITY_UPDATED",

  // Room events
  ROOM_JOINED = "ROOM_JOINED",
  ROOM_LEFT = "ROOM_LEFT",

  // Message events
  MESSAGE_RECEIVED = "MESSAGE_RECEIVED",
  MESSAGE_SENT = "MESSAGE_SENT",
  MESSAGE_DELETED = "MESSAGE_DELETED",

  // Channel events
  CHANNEL_CLEARED = "CHANNEL_CLEARED",

  // Voice events
  VOICE_MESSAGE_RECEIVED = "VOICE_MESSAGE_RECEIVED",
  VOICE_MESSAGE_SENT = "VOICE_MESSAGE_SENT",

  // Interaction events
  REACTION_RECEIVED = "REACTION_RECEIVED",
  POST_GENERATED = "POST_GENERATED",
  INTERACTION_RECEIVED = "INTERACTION_RECEIVED",

  // Run events
  RUN_STARTED = "RUN_STARTED",
  RUN_ENDED = "RUN_ENDED",
  RUN_TIMEOUT = "RUN_TIMEOUT",

  // Action events
  ACTION_STARTED = "ACTION_STARTED",
  ACTION_COMPLETED = "ACTION_COMPLETED",

  // Evaluator events
  EVALUATOR_STARTED = "EVALUATOR_STARTED",
  EVALUATOR_COMPLETED = "EVALUATOR_COMPLETED",

  // Model events
  MODEL_USED = "MODEL_USED",

  // Embedding events
  EMBEDDING_GENERATION_REQUESTED = "EMBEDDING_GENERATION_REQUESTED",
  EMBEDDING_GENERATION_COMPLETED = "EMBEDDING_GENERATION_COMPLETED",
  EMBEDDING_GENERATION_FAILED = "EMBEDDING_GENERATION_FAILED",

  // Control events
  CONTROL_MESSAGE = "CONTROL_MESSAGE",

  // Form events
  FORM_FIELD_CONFIRMED = "FORM_FIELD_CONFIRMED",
  FORM_FIELD_CANCELLED = "FORM_FIELD_CANCELLED",
}

/**
 * Platform-specific event type prefix
 */
export enum PlatformPrefix {
  DISCORD = "DISCORD",
  TELEGRAM = "TELEGRAM",
  X = "X",
}

/**
 * Base payload interface for all events
 */
export interface EventPayload {
  runtime: IAgentRuntime;
  source?: string;
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
    originalId: string;
    username: string;
    displayName?: string;
    type?: string;
  };
}

/**
 * Payload for reaction-related events
 */
export interface MessagePayload extends EventPayload {
  message: Memory;
  callback?: HandlerCallback;
}

/**
 * Payload for channel cleared events
 */
export interface ChannelClearedPayload extends EventPayload {
  roomId: UUID;
}

/**
 * Payload for events that are invoked without a message
 */
export interface InvokePayload extends EventPayload {
  worldId: UUID;
  roomId: UUID;
  userId?: UUID;
  source?: string;
  callback?: HandlerCallback;
}

/**
 * Run event payload type
 */
export interface RunEventPayload extends EventPayload {
  runId: UUID;
  messageId: UUID;
  roomId: UUID;
  entityId: UUID;
  startTime: number | bigint;
  status: "started" | "completed" | "timeout";
  endTime?: number | bigint;
  duration?: number | bigint;
  error?: string | Error;
}

/**
 * Action event payload type
 */
export interface ActionEventPayload extends EventPayload {
  roomId: UUID;
  world: UUID;
  content: Content;
  messageId?: UUID;
}

/**
 * Evaluator event payload type
 */
export interface EvaluatorEventPayload extends EventPayload {
  evaluatorId: UUID;
  evaluatorName: string;
  startTime?: number | bigint;
  completed?: boolean;
  error?: Error;
}

/**
 * Model event payload type
 */
export interface ModelEventPayload extends EventPayload {
  type: ModelTypeName;
  tokens?: {
    prompt: number;
    completion: number;
    total: number;
  };
}

/**
 * Payload for embedding generation events
 */
export interface EmbeddingGenerationPayload extends EventPayload {
  memory: Memory;
  priority?: "high" | "normal" | "low";
  embedding?: number[];
  error?: Error | string;
  runId?: UUID;
  retryCount?: number;
  maxRetries?: number;
}

/**
 * Payload for control message events
 */
export interface ControlMessagePayload extends EventPayload {
  message: ControlMessage;
}

export interface FormFieldEventPayload extends EventPayload {
  sessionId: string;
  entityId: UUID;
  field: string;
  value?: JsonValue;
  externalData?: JsonValue;
  reason?: string;
}

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
  [EventType.VOICE_MESSAGE_RECEIVED]: MessagePayload;
  [EventType.VOICE_MESSAGE_SENT]: MessagePayload;
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
  [EventType.EMBEDDING_GENERATION_REQUESTED]: EmbeddingGenerationPayload;
  [EventType.EMBEDDING_GENERATION_COMPLETED]: EmbeddingGenerationPayload;
  [EventType.EMBEDDING_GENERATION_FAILED]: EmbeddingGenerationPayload;
  [EventType.CONTROL_MESSAGE]: ControlMessagePayload;
  [EventType.FORM_FIELD_CONFIRMED]: FormFieldEventPayload;
  [EventType.FORM_FIELD_CANCELLED]: FormFieldEventPayload;
}

/**
 * Event handler function type
 */
export type EventHandler<T extends keyof EventPayloadMap> = (
  payload: EventPayloadMap[T],
) => Promise<void>;
