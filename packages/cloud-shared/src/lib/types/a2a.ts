/**
 * A2A Protocol Types
 *
 * Type definitions conforming to the A2A specification v0.3.0
 * @see https://google.github.io/a2a-spec/
 */

// ===== Core Enums =====

export type TaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "auth-required"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected";

export type Role = "user" | "agent";

export type PartType = "text" | "file" | "data";

// ===== Part Types =====

interface PartBase {
  type: PartType;
  metadata?: Record<string, unknown>;
}

export interface TextPart extends PartBase {
  type: "text";
  text: string;
}

export interface FileWithBytes {
  name?: string;
  mimeType?: string;
  bytes: string; // Base64 encoded
}

export interface FileWithUri {
  name?: string;
  mimeType?: string;
  uri: string;
}

export interface FilePart extends PartBase {
  type: "file";
  file: FileWithBytes | FileWithUri;
}

export interface DataPart extends PartBase {
  type: "data";
  data: object;
}

export type Part = TextPart | FilePart | DataPart;

// ===== Message =====

export interface Message {
  role: Role;
  parts: Part[];
  metadata?: Record<string, unknown>;
}

// ===== Task Status =====

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp: string;
}

// ===== Artifact =====

export interface Artifact {
  name?: string;
  description?: string;
  parts: Part[];
  index?: number;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

// ===== Task =====

export interface Task {
  id: string;
  contextId?: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
}

// ===== Push Notification Config =====

export interface PushNotificationAuthenticationInfo {
  schemes: string[];
  credentials?: string;
}

export interface PushNotificationConfig {
  url: string;
  token?: string;
  authentication?: PushNotificationAuthenticationInfo;
}

export interface TaskPushNotificationConfig {
  id: string;
  taskId: string;
  pushNotificationConfig: PushNotificationConfig;
}

// ===== Method Parameters =====

export interface MessageSendConfiguration {
  acceptedOutputModes?: string[];
  historyLength?: number;
  pushNotificationConfig?: PushNotificationConfig;
  blocking?: boolean;
}

export interface MessageSendParams {
  message: Message;
  configuration?: MessageSendConfiguration;
  metadata?: Record<string, unknown>;
}

export interface TaskGetParams {
  id: string;
  historyLength?: number;
}

export interface TaskCancelParams {
  id: string;
}

export interface TaskResubscribeParams {
  id: string;
}

export interface SetTaskPushNotificationParams {
  id: string;
  pushNotificationConfig: PushNotificationConfig;
}

export interface GetTaskPushNotificationParams {
  taskId: string;
  id: string;
}

export interface DeleteTaskPushNotificationParams {
  taskId: string;
  id: string;
}

// ===== Streaming Response Types =====

export interface TaskStatusUpdateEvent {
  id: string;
  status: TaskStatus;
  final?: boolean;
  metadata?: Record<string, unknown>;
}

export interface TaskArtifactUpdateEvent {
  id: string;
  artifact: Artifact;
  metadata?: Record<string, unknown>;
}

export type SendStreamingMessageResponse =
  | { type: "status"; data: TaskStatusUpdateEvent }
  | { type: "artifact"; data: TaskArtifactUpdateEvent };

// ===== JSON-RPC Types =====

export interface JSONRPCRequest<T = Record<string, unknown>> {
  jsonrpc: "2.0";
  method: string;
  params?: T;
  id: string | number | null;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface JSONRPCSuccessResponse<T = unknown> {
  jsonrpc: "2.0";
  result: T;
  id: string | number | null;
}

export interface JSONRPCErrorResponse {
  jsonrpc: "2.0";
  error: JSONRPCError;
  id: string | number | null;
}

export type JSONRPCResponse<T = unknown> = JSONRPCSuccessResponse<T> | JSONRPCErrorResponse;

// ===== A2A Error Codes =====

export const A2AErrorCodes = {
  // Standard JSON-RPC errors
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  // A2A specific errors
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  AUTHENTICATION_REQUIRED: -32010,
  INSUFFICIENT_CREDITS: -32011,
  RATE_LIMITED: -32012,
  AGENT_BANNED: -32013,
} as const;

// ===== Helper Functions =====

export function createTextPart(text: string, metadata?: Record<string, unknown>): TextPart {
  return { type: "text", text, metadata };
}

export function createDataPart(data: object, metadata?: Record<string, unknown>): DataPart {
  return { type: "data", data, metadata };
}

export function createFilePart(
  file: FileWithBytes | FileWithUri,
  metadata?: Record<string, unknown>,
): FilePart {
  return { type: "file", file, metadata };
}

export function createMessage(
  role: Role,
  parts: Part[],
  metadata?: Record<string, unknown>,
): Message {
  return { role, parts, metadata };
}

export function createTask(
  id: string,
  state: TaskState,
  message?: Message,
  contextId?: string,
  metadata?: Record<string, unknown>,
): Task {
  return {
    id,
    contextId,
    status: {
      state,
      message,
      timestamp: new Date().toISOString(),
    },
    metadata,
  };
}

export function createTaskStatus(state: TaskState, message?: Message): TaskStatus {
  return {
    state,
    message,
    timestamp: new Date().toISOString(),
  };
}

export function createArtifact(
  parts: Part[],
  name?: string,
  description?: string,
  index?: number,
  metadata?: Record<string, unknown>,
): Artifact {
  return { parts, name, description, index, metadata };
}

export function jsonRpcSuccess<T>(
  result: T,
  id: string | number | null,
): JSONRPCSuccessResponse<T> {
  return { jsonrpc: "2.0", result, id };
}

export function jsonRpcError(
  code: number,
  message: string,
  id: string | number | null,
  data?: Record<string, unknown>,
): JSONRPCErrorResponse {
  return { jsonrpc: "2.0", error: { code, message, data }, id };
}

// ===== Method Type Mapping =====

export type A2AMethodName =
  | "message/send"
  | "message/stream"
  | "tasks/get"
  | "tasks/cancel"
  | "tasks/resubscribe"
  | "tasks/pushNotificationConfig/set"
  | "tasks/pushNotificationConfig/get"
  | "tasks/pushNotificationConfig/delete"
  | "agent/getAuthenticatedExtendedCard";

export type A2AMethodParams = {
  "message/send": MessageSendParams;
  "message/stream": MessageSendParams;
  "tasks/get": TaskGetParams;
  "tasks/cancel": TaskCancelParams;
  "tasks/resubscribe": TaskResubscribeParams;
  "tasks/pushNotificationConfig/set": SetTaskPushNotificationParams;
  "tasks/pushNotificationConfig/get": GetTaskPushNotificationParams;
  "tasks/pushNotificationConfig/delete": DeleteTaskPushNotificationParams;
  "agent/getAuthenticatedExtendedCard": Record<string, never>;
};
