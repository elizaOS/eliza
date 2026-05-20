/**
 * SSE (Server-Sent Events) module exports.
 *
 * This module provides a clean, encapsulated API for managing SSE connections.
 * The SSEManager singleton handles all connection logic, while the React hooks
 * provide convenient integration with React components.
 */

export {
  type AuthTokenProvider,
  type Channel,
  type ConnectionState,
  type ConnectionStateListener,
  type DynamicChannel,
  type SSECallback,
  SSEManager,
  type SSEManagerConfig,
  type SSEMessage,
  type StaticChannel,
} from "./SSEManager";
