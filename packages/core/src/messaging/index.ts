/**
 * Message Bus Module
 *
 * Provides a unified, browser-compatible message bus system for ElizaOS.
 * This replaces the old MessageBusService with a clean, pluggable architecture.
 */

// Core MessageBus
export { MessageBus } from './message-bus';

// Types
export * from './types';

// Transports
export { MemoryTransport } from './transports/memory-transport';
export { WebSocketTransport } from './transports/web-socket-transport';
export { HttpTransport } from './transports/http-transport';
