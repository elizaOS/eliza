/**
 * Hooks Type Definitions
 *
 * Core types for Milady's event-driven hooks system.
 *
 * @module hooks/types
 */

// ---------- Event Types ----------

/** Supported hook event categories. */
export type HookEventType = "command" | "session" | "agent" | "gateway";

/** A hook event dispatched to registered handlers. */
export interface HookEvent {
  /** Event category. */
  type: HookEventType;
  /** Specific action within the category (e.g., "new", "reset", "startup"). */
  action: string;
  /** Session key where the event occurred. */
  sessionKey: string;
  /** Event timestamp. */
  timestamp: Date;
  /** Messages to be sent back to the user. Handlers can push to this array. */
  messages: string[];
  /** Additional context data. */
  context: Record<string, unknown>;
}

/** Handler function signature. */
export type HookHandler = (event: HookEvent) => Promise<void> | void;

// ---------- Hook Metadata ----------

/** Milady-specific hook metadata from HOOK.md frontmatter. */
export interface MiladyHookMetadata {
  /** Bypass eligibility checks. */
  always?: boolean;
  /** Config key override (defaults to hook name). */
  hookKey?: string;
  /** Display emoji. */
  emoji?: string;
  /** Documentation URL. */
  homepage?: string;
  /** Events this hook handles. */
  events: string[];
  /** Named export to use (defaults to "default"). */
  export?: string;
  /** Required platforms (darwin, linux, win32). */
  os?: string[];
  /** Requirements for eligibility. */
  requires?: {
    /** All listed binaries must exist on PATH. */
    bins?: string[];
    /** At least one listed binary must exist on PATH. */
    anyBins?: string[];
    /** Required environment variables. */
    env?: string[];
    /** Required config paths (must be truthy). */
    config?: string[];
  };
  /** Installation methods for the macOS Skills UI. */
  install?: HookInstallSpec[];
}

/** Hook installation specification. */
export interface HookInstallSpec {
  id: string;
  kind: "bundled" | "npm" | "git" | "download";
  formula?: string;
  bins?: string[];
  label?: string;
  os?: string[];
}

/** Parsed frontmatter from HOOK.md. */
export interface ParsedHookFrontmatter {
  name: string;
  description: string;
  homepage?: string;
  metadata?: {
    milady?: MiladyHookMetadata;
  };
}

/** Hook source type. */
export type HookSource =
  | "milady-bundled"
  | "milady-managed"
  | "milady-workspace"
  | "milady-plugin";

/** A discovered hook. */
export interface Hook {
  name: string;
  description: string;
  source: HookSource;
  pluginId?: string;
  filePath: string;
  baseDir: string;
  handlerPath: string;
}

/** Hook entry with parsed metadata. */
export interface HookEntry {
  hook: Hook;
  frontmatter: ParsedHookFrontmatter;
  metadata?: MiladyHookMetadata;
}

/** Hook status for listing/display. */
export interface HookStatus {
  name: string;
  description: string;
  source: HookSource;
  emoji?: string;
  events: string[];
  enabled: boolean;
  eligible: boolean;
  missingRequirements?: string[];
}
