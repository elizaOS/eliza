/**
 * App Builder Types
 *
 * Shared type definitions for the app builder feature.
 */

import type { LucideIcon } from "lucide-react";

export type TemplateType =
  | "chat"
  | "agent-dashboard"
  | "landing-page"
  | "analytics"
  | "blank"
  | "mcp-service"
  | "a2a-agent"
  | "saas-starter"
  | "ai-tool";

export type SessionStatus =
  | "idle"
  | "initializing"
  | "ready"
  | "generating"
  | "error"
  | "stopped"
  | "timeout"
  | "not_configured"
  | "recovering";

export type ProgressStep =
  | "creating"
  | "installing"
  | "starting"
  | "restoring"
  | "ready"
  | "error";

export type SourceType = "agent" | "workflow" | "service" | "standalone";

export interface MessageOperation {
  tool: string;
  detail: string;
  timestamp: string; // When the operation was performed
  reasoning?: string; // Reasoning that led to this operation (for accordion)
}

/** Image attachment preview for display in chat */
export interface MessageImagePreview {
  id: string;
  previewUrl: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  reasoning?: string; // Overall reasoning (deprecated - use operations.reasoning)
  operations?: MessageOperation[]; // Per-operation data with reasoning for accordions
  filesAffected?: string[];
  images?: MessageImagePreview[]; // Attached images for preview
  timestamp: string;
  _thinkingId?: number;
}

export interface SessionData {
  id: string;
  sandboxId: string;
  sandboxUrl: string;
  status: SessionStatus;
  examplePrompts: string[];
  expiresAt: string | null;
  appId?: string;
  githubRepo?: string | null;
}

export interface SourceContext {
  type: SourceType;
  id: string;
  name: string;
}

export interface AppData {
  id: string;
  name: string;
  description: string | null;
  monetization_enabled?: boolean;
  github_repo?: string | null;
  linked_agent_ids?: string[];
}

export interface GitStatusInfo {
  hasChanges: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  currentCommitSha: string | null;
  lastSavedCommitSha: string | null;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface TemplateOption {
  value: TemplateType;
  label: string;
  description: string;
  longDescription: string;
  icon: LucideIcon;
  color: string;
  gradient: string;
  features: string[];
  techStack: string[];
  comingSoon?: boolean;
}

export interface SnapshotInfo {
  canRestore: boolean;
  githubRepo: string | null;
  lastBackup: string | null;
}

export interface AppSnapshotInfo {
  githubRepo: string;
  lastBackup: string | null;
}

export interface RestoreProgress {
  current: number;
  total: number;
  filePath: string;
}

export type PreviewTab = "preview" | "console" | "files" | "history" | "agents";

export interface SourceContextInfo {
  icon: LucideIcon;
  color: string;
  templateSuggestion: TemplateType;
}

/** Maximum number of console logs to retain */
export const MAX_CONSOLE_LOGS = 500;

/**
 * Available AI models for the App Builder.
 * These are accessible through the AI Gateway.
 */
export interface AppBuilderModel {
  id: string;
  name: string;
  description: string;
  provider: string;
}

/**
 * Default models available for App Builder.
 * Matches the models available in chat for consistency.
 */
export const APP_BUILDER_MODELS: AppBuilderModel[] = [
  {
    id: "anthropic/claude-opus-4.5",
    name: "Claude Opus 4.5",
    description: "Most capable model for complex coding tasks",
    provider: "Anthropic",
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    description: "Best for complex coding tasks with excellent reasoning",
    provider: "Anthropic",
  },
  {
    id: "openai/gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    description: "OpenAI's most capable coding model",
    provider: "OpenAI",
  },
  {
    id: "openai/gpt-5.2",
    name: "GPT-5.2",
    description: "OpenAI's most capable multimodal model",
    provider: "OpenAI",
  },
  {
    id: "xai/grok-code-fast-1",
    name: "Grok Code Fast",
    description: "xAI's fast coding model",
    provider: "xAI",
  },
  {
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek V3.2",
    description: "DeepSeek's advanced reasoning model",
    provider: "DeepSeek",
  },
  {
    id: "google/gemini-3-flash",
    name: "Gemini 3 Flash",
    description: "Google's fast multimodal model",
    provider: "Google",
  },
];

export const DEFAULT_APP_BUILDER_MODEL = "anthropic/claude-opus-4.5";
