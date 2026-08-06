/**
 * Shared TypeScript types for Clawd CLI.
 */

import type { ProviderId } from "../grok/models";

// === Chat / Agent Types ===

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  // biome-ignore lint/suspicious/noExplicitAny: tool payloads are provider/tool-specific extension data.
  diff?: any;
  plan?: Plan;
  // biome-ignore lint/suspicious/noExplicitAny: delegated agents return heterogeneous task metadata.
  task?: any;
  // biome-ignore lint/suspicious/noExplicitAny: background process metadata varies by tool implementation.
  backgroundProcess?: any;
  media?: MediaAsset[];
  computer?: ComputerToolMetadata;
  delegation?: DelegationRunSummary;
  verifyRecipe?: VerifyRecipe;
  // biome-ignore lint/suspicious/noExplicitAny: LSP diagnostic payloads are passed through from language servers.
  lspDiagnostics?: any[];
  // biome-ignore lint/suspicious/noExplicitAny: tool results are intentionally extensible.
  [key: string]: any;
}

export interface ToolCall {
  type?: string;
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatEntry {
  role?: "system" | "user" | "assistant" | "tool";
  // biome-ignore lint/suspicious/noExplicitAny: chat content can be text, structured blocks, or SDK-specific parts.
  content: any;
  type?: string;
  timestamp?: Date;
  remoteKey?: string;
  modeColor?: string;
  sourceLabel?: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
  toolCall?: ToolCall;
  toolResult?: ToolResult;
}

// === Stream Types ===

export interface StreamToken {
  type: "token";
  text: string;
}

export interface StreamToolCall {
  type: "tool_call";
  id: string;
  name: string;
  arguments: string;
}

export interface StreamToolResult {
  type: "tool_result";
  id?: string;
  name?: string;
  result?: ToolResult;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
}

export interface StreamError {
  type: "error";
  message?: string;
  content?: string;
  isAuthError?: boolean;
}

export interface StreamDone {
  type: "done";
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface StreamContent {
  type: "content";
  content: string;
}

export interface StreamReasoning {
  type: "reasoning";
  content: string;
}

export interface StreamToolCalls {
  type: "tool_calls";
  toolCalls: ToolCall[];
}

export interface StreamToolApprovalRequest {
  type: "tool_approval_request";
  toolCall: ToolCall;
  approvalId: string;
  paymentPrecheck?: PaymentPrecheck;
}

// biome-ignore lint/suspicious/noExplicitAny: stream chunks include SDK-specific incremental event shapes.
export type StreamChunk = any;

export type AgentMode = string;

export interface PlanQuestion {
  id: string;
  type?: string;
  header?: string;
  question: string;
  // biome-ignore lint/suspicious/noExplicitAny: plan option shapes are normalized by the UI layer.
  options?: any[];
}

export interface PlanStep {
  title?: string;
  description?: string;
  status?: string;
  filePaths?: string[];
}

export interface Plan {
  summary?: string;
  steps: PlanStep[];
  questions?: PlanQuestion[];
  files?: string[];
  // biome-ignore lint/suspicious/noExplicitAny: plans may carry tool-specific metadata.
  [key: string]: any;
}

export interface WorkspaceInfo {
  id: string;
  scopeKey: string;
  canonicalPath: string;
  gitRoot: string | null;
  displayName: string;
  lastSeenAt: Date;
}

export type SessionStatus = "active" | "archived";

export interface SessionRecap {
  text: string;
  model: string | null;
  updatedAt: Date | null;
}

export interface SessionInfo {
  id: string;
  workspaceId: string;
  title: string | null;
  recap: SessionRecap | null;
  model: string;
  mode: AgentMode;
  cwdAtStart: string;
  cwdLast: string;
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionSnapshot {
  session: SessionInfo;
  workspace?: WorkspaceInfo;
  messages?: ChatEntry[];
  entries?: ChatEntry[];
  totalTokens?: number;
  // biome-ignore lint/suspicious/noExplicitAny: snapshots include forward-compatible persisted fields.
  [key: string]: any;
}

// biome-ignore lint/suspicious/noExplicitAny: subagent status is transport-specific.
export type SubagentStatus = any;
export type UsageSource = "chat" | "tool" | "recap" | "title" | string;
export interface PaymentPrecheck {
  enabled?: boolean;
  approved?: boolean;
  reason?: string;
  // biome-ignore lint/suspicious/noExplicitAny: payment providers can attach provider-specific precheck metadata.
  [key: string]: any;
}

export interface MediaAsset {
  kind: "image" | "video";
  path: string;
  url?: string;
  mediaType?: string;
  prompt?: string;
  sourcePath?: string;
  sourceUrl?: string;
  durationSeconds?: number;
  modelId?: string;
}

export interface VerifyArtifact {
  kind: "log" | "screenshot" | "video";
  path: string;
  description: string;
}

export interface ComputerToolMetadata {
  action: string;
  path?: string;
  app?: string;
  windowId?: string;
  ref?: string;
  hint?: string;
}

export interface TaskRequest {
  agent: string;
  prompt: string;
  description: string;
}

export type DelegationStatus = "running" | "complete" | "error";

export interface DelegationRunSummary {
  id: string;
  agent: string;
  description: string;
  summary: string;
  status: DelegationStatus;
}

export interface DelegationRun extends DelegationRunSummary {
  prompt?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface VerifyRecipe {
  ecosystem: string;
  appKind: string;
  appLabel: string;
  shellInitCommands: string[];
  bootstrapCommands: string[];
  installCommands: string[];
  buildCommands: string[];
  testCommands: string[];
  startCommand?: string;
  startPort?: string;
  smokeKind: "http" | "cli" | "none";
  smokeTarget?: string;
  evidence: string[];
  notes: string[];
}

export interface VerifyEnvironmentManifest {
  recipe?: Partial<VerifyRecipe> & Record<string, unknown>;
  sandbox?: Record<string, unknown>;
  ecosystem?: string;
  appKind?: string;
  appLabel?: string;
  shellInitCommands?: string[];
  shellInit?: string[];
  bootstrapCommands?: string[];
  bootstrap?: string[];
  installCommands?: string[];
  install?: string[];
  buildCommands?: string[];
  build?: string[];
  testCommands?: string[];
  test?: string[];
  startCommand?: string;
  start?: string;
  startPort?: string;
  smokeKind?: "http" | "cli" | "none";
  smokeTarget?: string;
  evidence?: string[] | string;
  notes?: string[] | string;
}

// === Solana Types ===

export interface SolanaConfig {
  rpcUrl: string;
  apiUrl?: string;
  apiKey?: string;
}

export interface WalletInfo {
  name: string;
  publicKey: string;
  isDefault: boolean;
  createdAt: string;
}

export interface MarketInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  tickSize: number;
  lotSize: number;
  minOrderSize: number;
  maxLeverage: number;
  fees: {
    makerBps: number;
    takerBps: number;
  };
}

export interface TickerData {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  lastPrice: number;
  volume24h: number;
  openInterest: number;
  fundingRate: number;
  fundingRateApr: number;
  timestamp: number;
}

export interface OrderbookLevel {
  price: number;
  size: number;
  orderCount?: number;
}

export interface OrderbookSnapshot {
  symbol: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  timestamp: number;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradeRecord {
  id: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  value: number;
  timestamp: number;
}

// === Position & Order Types ===

export interface Position {
  symbol: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  marginMode: "cross" | "isolated";
  marginUsed: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  realizedPnl: number;
  leverage: number;
  takeProfit?: number;
  stopLoss?: number;
}

export interface OpenOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit";
  price: number;
  size: number;
  filled: number;
  remaining: number;
  status: "open" | "partial" | "filled" | "cancelled";
  reduceOnly: boolean;
  postOnly: boolean;
  timestamp: number;
}

export interface MarginStatus {
  equity: number;
  availableBalance: number;
  marginUsed: number;
  marginRatio: number;
  maintenanceMargin: number;
  maintenanceMarginRatio: number;
  initialMarginRatio: number;
}

export interface PortfolioSnapshot {
  margin: MarginStatus;
  positions: Position[];
  orders: OpenOrder[];
  timestamp: number;
}

// === Strategy Types ===

export type ExecutionMode = "paper" | "dry-run" | "confirm-each" | "auto-execute";
export type MarginMode = "cross" | "isolated";
export type StrategyStatus = "running" | "paused" | "stopped" | "completed" | "error";

export interface StrategyRunInfo {
  id: string;
  type: "twap" | "grid" | "ta";
  symbol: string;
  status: StrategyStatus;
  label?: string;
  createdAt: string;
  updatedAt: string;
  executionMode: ExecutionMode;
}

export interface GuardrailConfig {
  maxTotalNotionalUsdc?: number;
  maxStepNotionalUsdc?: number;
  maxPriceDriftBps?: number;
  maxExposureRatio?: number;
  reconcileAttempts?: number;
  reconcileDelayMs?: number;
}

// === Technical Analysis Types ===

export type IndicatorName = "sma" | "ema" | "rsi" | "macd" | "bbands" | "atr" | "vwap" | "adx" | "stoch";

export interface IndicatorParams {
  period?: number;
  fast?: number;
  slow?: number;
  signal?: number;
  multiplier?: number;
}

export interface IndicatorResult {
  indicator: IndicatorName;
  timeframe: string;
  value: number | number[];
  metadata?: Record<string, number>;
  timestamp: number;
}

export interface SignalSpec {
  indicator: IndicatorName;
  timeframe: string;
  op: "gt" | "lt" | "gte" | "lte" | "eq" | "cross_above" | "cross_below";
  threshold: number;
  params?: IndicatorParams;
}

// === API Types ===

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  ok: false;
  error: {
    category: string;
    code: string;
    message: string;
    retryable: boolean;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// === Agent Config Types ===

export interface AgentConfig {
  session?: string;
  sandboxMode?: string;
  sandboxSettings?: Record<string, unknown>;
  batchApi?: boolean;
  provider?: ProviderId;
  toolsets?: string[];
}

export interface ClawdSettings {
  defaultModel?: string;
  model?: string;
  provider?: ProviderId;
  defaultProvider?: ProviderId;
  baseURL?: string;
  providerApiKeys?: Partial<Record<ProviderId, string>>;
  providerBaseURLs?: Partial<Record<ProviderId, string>>;
  toolsets?: string[];
  defaultMaxToolRounds?: number;
  subAgents?: SubAgentConfig[];
  hooks?: HookConfig;
  telegram?: {
    botToken?: string;
    approvedUserIds?: number[];
    sessionsByUserId?: Record<string, string>;
    audioInput?: {
      enabled: boolean;
      language: string;
    };
  };
  mcpServers?: McpServerConfig[];
  sandboxMode?: string;
  sandbox?: unknown;
  apiKey?: string;
  reasoningEffortByModel?: Record<string, string>;
}

export interface SubAgentConfig {
  name: string;
  model: string;
  instruction: string;
}

export interface HookConfig {
  PreToolUse?: HookEvent[];
  PostToolUse?: HookEvent[];
  PostToolUseFailure?: HookEvent[];
  UserPromptSubmit?: HookEvent[];
  SessionStart?: HookEvent[];
  SessionEnd?: HookEvent[];
  Stop?: HookEvent[];
  StopFailure?: HookEvent[];
  SubagentStart?: HookEvent[];
  SubagentStop?: HookEvent[];
  Notification?: HookEvent[];
  InstructionsLoaded?: HookEvent[];
  CwdChanged?: HookEvent[];
}

export interface HookEvent {
  matcher?: string;
  hooks: HookDefinition[];
}

export interface HookDefinition {
  type: "command";
  command: string;
  timeout?: number;
}

export interface McpServerConfig {
  id: string;
  enabled?: boolean;
  label: string;
  transport: "stdio" | "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  autoApprove?: string[] | boolean;
}

export interface VerifyRetryStrategy {
  id: string;
  when: string;
  reason: string;
  commands: string[];
}

export interface FileDiff {
  filePath?: string;
  patch?: string;
  summary?: string;
  // biome-ignore lint/suspicious/noExplicitAny: diff providers may include additional metadata.
  [key: string]: any;
}

export interface ModelInfo {
  id: string;
  name?: string;
  // biome-ignore lint/suspicious/noExplicitAny: model registries may expose provider-specific fields.
  [key: string]: any;
}

export type ReasoningEffort = "low" | "high" | string;
export const MODES: Array<{ id: AgentMode; label: string; color: string }> = [
  { id: "agent", label: "Agent", color: "cyan" },
  { id: "ask", label: "Ask", color: "blue" },
  { id: "plan", label: "Plan", color: "amber" },
];

export interface UsageEvent {
  id?: number;
  sessionId?: string;
  source: UsageSource;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros?: number;
  createdAt?: Date;
}
