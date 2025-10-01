/**
 * MessageBusCore - Pure JavaScript message bus
 * @module @elizaos/core/messaging
 */

export { MessageBusCore } from './bus-core';
export type {
  Message,
  MessageInput,
  MessageBusAdapter,
  BusControlMessage,
  MessageBusEvent,
  MessageCallback,
  ControlCallback,
  UnsubscribeFunction,
} from './types';

// Export adapters
export { MessageDatabaseAdapter, AgentAdapter } from './adapters';
