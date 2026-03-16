import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import { apps } from "./apps";
import { users } from "./users";
import { organizations } from "./organizations";

/**
 * App sandbox sessions table schema.
 *
 * Tracks Vercel Sandbox instances for AI-powered app building.
 * Each session represents a sandbox connected to a GitHub repo.
 *
 * Storage is now handled by GitHub:
 * - Each app = one private GitHub repo
 * - Version history = git commits
 * - Restore = git clone
 */
export const appSandboxSessions = pgTable(
  "app_sandbox_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Session ownership
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    // Link to app (required - each session is for an app with a GitHub repo)
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),

    // Sandbox identification
    sandbox_id: text("sandbox_id").unique(), // Vercel Sandbox ID
    sandbox_url: text("sandbox_url"), // Public URL to the sandbox dev server

    // Git branch being edited (default: main)
    git_branch: text("git_branch").default("main").notNull(),

    // Last known commit SHA
    last_commit_sha: text("last_commit_sha"),

    // Session status
    status: text("status")
      .$type<
        | "initializing"
        | "ready"
        | "generating"
        | "error"
        | "stopped"
        | "timeout"
      >()
      .notNull()
      .default("initializing"),
    status_message: text("status_message"),

    // App metadata
    app_name: text("app_name"),
    app_description: text("app_description"),
    initial_prompt: text("initial_prompt"),
    template_type: text("template_type")
      .$type<
        | "chat"
        | "agent-dashboard"
        | "landing-page"
        | "analytics"
        | "blank"
        | "mcp-service"
        | "a2a-agent"
        | "saas-starter"
        | "ai-tool"
      >()
      .default("blank"),

    // Build configuration
    build_config: jsonb("build_config")
      .$type<{
        features?: string[];
        integrations?: string[];
        styling?: "minimal" | "branded" | "custom";
        includeAnalytics?: boolean;
        includeMonetization?: boolean;
        includeDatabase?: boolean;
      }>()
      .default({})
      .notNull(),

    // Claude session tracking
    claude_session_id: text("claude_session_id"),
    claude_messages: jsonb("claude_messages")
      .$type<
        Array<{
          role: "user" | "assistant" | "system";
          content: string;
          timestamp: string;
        }>
      >()
      .default([])
      .notNull(),

    // Files generated/modified during the session
    generated_files: jsonb("generated_files")
      .$type<
        Array<{
          path: string;
          type: "created" | "modified" | "deleted";
          timestamp: string;
        }>
      >()
      .default([])
      .notNull(),

    // Resource usage
    cpu_seconds_used: integer("cpu_seconds_used").default(0).notNull(),
    memory_mb_peak: integer("memory_mb_peak").default(0),

    // Timestamps
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    started_at: timestamp("started_at"),
    stopped_at: timestamp("stopped_at"),
    expires_at: timestamp("expires_at"),
  },
  (table) => ({
    user_id_idx: index("app_sandbox_sessions_user_id_idx").on(table.user_id),
    organization_id_idx: index("app_sandbox_sessions_org_id_idx").on(
      table.organization_id,
    ),
    app_id_idx: index("app_sandbox_sessions_app_id_idx").on(table.app_id),
    sandbox_id_idx: index("app_sandbox_sessions_sandbox_id_idx").on(
      table.sandbox_id,
    ),
    status_idx: index("app_sandbox_sessions_status_idx").on(table.status),
    created_at_idx: index("app_sandbox_sessions_created_at_idx").on(
      table.created_at,
    ),
  }),
);

/**
 * App builder prompts table schema.
 *
 * Stores conversation history between user and AI for app building sessions.
 */
export const appBuilderPrompts = pgTable(
  "app_builder_prompts",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    sandbox_session_id: uuid("sandbox_session_id")
      .notNull()
      .references(() => appSandboxSessions.id, { onDelete: "cascade" }),

    // Message details
    role: text("role").$type<"user" | "assistant" | "system">().notNull(),
    content: text("content").notNull(),

    // Response metadata (for assistant messages)
    files_affected: jsonb("files_affected").$type<string[]>().default([]),

    // Git commit created by this prompt (if any)
    commit_sha: text("commit_sha"),

    // Status
    status: text("status")
      .$type<"pending" | "processing" | "completed" | "error">()
      .notNull()
      .default("pending"),
    error_message: text("error_message"),

    // Timing
    created_at: timestamp("created_at").notNull().defaultNow(),
    completed_at: timestamp("completed_at"),
    duration_ms: integer("duration_ms"),
  },
  (table) => ({
    session_idx: index("app_builder_prompts_session_idx").on(
      table.sandbox_session_id,
    ),
    created_at_idx: index("app_builder_prompts_created_at_idx").on(
      table.created_at,
    ),
  }),
);

/**
 * App templates table schema.
 *
 * Pre-built templates stored as GitHub repos that users can start from.
 */
export const appTemplates = pgTable(
  "app_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Template identification
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description"),
    category: text("category")
      .$type<
        "chat" | "agent" | "dashboard" | "landing" | "analytics" | "utility"
      >()
      .notNull(),

    // Template content - now points to GitHub repo
    preview_image_url: text("preview_image_url"),
    github_repo: text("github_repo").notNull(), // org/repo format
    github_branch: text("github_branch").default("main"),

    // Features included
    features: jsonb("features").$type<string[]>().default([]).notNull(),

    // AI prompts for this template
    system_prompt: text("system_prompt"),
    example_prompts: jsonb("example_prompts")
      .$type<string[]>()
      .default([])
      .notNull(),

    // Usage tracking
    usage_count: integer("usage_count").default(0).notNull(),

    // Status
    is_active: boolean("is_active").default(true).notNull(),
    is_featured: boolean("is_featured").default(false).notNull(),

    // Timestamps
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    slug_idx: index("app_templates_slug_idx").on(table.slug),
    category_idx: index("app_templates_category_idx").on(table.category),
    is_active_idx: index("app_templates_is_active_idx").on(table.is_active),
    is_featured_idx: index("app_templates_is_featured_idx").on(
      table.is_featured,
    ),
  }),
);

/**
 * Session file snapshots table schema.
 *
 * Stores point-in-time snapshots of files in a sandbox session.
 * Used for backup/restore functionality when sandbox instances expire.
 *
 * Note: Future versions will migrate to GitHub-based storage where each app
 * has its own repository, and file history is managed via git commits.
 * These tables remain for backward compatibility and as a fallback.
 */
export const sessionFileSnapshots = pgTable(
  "session_file_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    sandbox_session_id: uuid("sandbox_session_id")
      .notNull()
      .references(() => appSandboxSessions.id, { onDelete: "cascade" }),

    file_path: text("file_path").notNull(),
    content: text("content").notNull(),
    content_hash: text("content_hash").notNull(),
    file_size: integer("file_size").default(0).notNull(),

    snapshot_type: text("snapshot_type")
      .$type<"auto" | "manual" | "pre_expiry" | "prompt_complete">()
      .default("auto")
      .notNull(),

    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    session_idx: index("session_file_snapshots_session_idx").on(
      table.sandbox_session_id,
    ),
    session_path_idx: index("session_file_snapshots_session_path_idx").on(
      table.sandbox_session_id,
      table.file_path,
    ),
    created_at_idx: index("session_file_snapshots_created_at_idx").on(
      table.created_at,
    ),
  }),
);

/**
 * Session restore history table schema.
 *
 * Tracks when sessions are restored from snapshots to new sandbox instances.
 * Useful for debugging and understanding session lifecycle.
 *
 * Note: When GitHub-based storage is fully implemented, this will be replaced
 * by git clone operations and commit history.
 */
export const sessionRestoreHistory = pgTable(
  "session_restore_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    sandbox_session_id: uuid("sandbox_session_id")
      .notNull()
      .references(() => appSandboxSessions.id, { onDelete: "cascade" }),

    old_sandbox_id: text("old_sandbox_id"),
    new_sandbox_id: text("new_sandbox_id"),
    files_restored: integer("files_restored").default(0).notNull(),
    restore_duration_ms: integer("restore_duration_ms"),

    status: text("status")
      .$type<"pending" | "in_progress" | "completed" | "failed">()
      .default("pending")
      .notNull(),
    error_message: text("error_message"),

    created_at: timestamp("created_at").notNull().defaultNow(),
    completed_at: timestamp("completed_at"),
  },
  (table) => ({
    session_idx: index("session_restore_history_session_idx").on(
      table.sandbox_session_id,
    ),
  }),
);

// Type inference
export type AppSandboxSession = InferSelectModel<typeof appSandboxSessions>;
export type NewAppSandboxSession = InferInsertModel<typeof appSandboxSessions>;
export type AppBuilderPrompt = InferSelectModel<typeof appBuilderPrompts>;
export type NewAppBuilderPrompt = InferInsertModel<typeof appBuilderPrompts>;
export type AppTemplate = InferSelectModel<typeof appTemplates>;
export type NewAppTemplate = InferInsertModel<typeof appTemplates>;
export type SessionFileSnapshot = InferSelectModel<typeof sessionFileSnapshots>;
export type NewSessionFileSnapshot = InferInsertModel<
  typeof sessionFileSnapshots
>;
export type SessionRestoreHistory = InferSelectModel<
  typeof sessionRestoreHistory
>;
export type NewSessionRestoreHistory = InferInsertModel<
  typeof sessionRestoreHistory
>;
/**
 * Sandbox template snapshots table schema.
 *
 * Stores Vercel Sandbox snapshots for templates to enable faster startup.
 * Instead of cloning from git and reinstalling dependencies each time,
 * sandboxes can be created from a snapshot that already has everything set up.
 *
 * Snapshots expire after 7 days (Vercel's limit), so we track expiration
 * and automatically refresh them.
 *
 * @see https://vercel.com/docs/vercel-sandbox#snapshotting
 */
export const sandboxTemplateSnapshots = pgTable(
  "sandbox_template_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Snapshot identification
    snapshot_id: text("snapshot_id").notNull().unique(), // Vercel Sandbox snapshot ID
    template_key: text("template_key").notNull(), // e.g., "default", "chat", template slug

    // Source tracking
    github_repo: text("github_repo"), // The GitHub repo this snapshot was created from
    github_commit_sha: text("github_commit_sha"), // Commit SHA at time of snapshot

    // Snapshot metadata
    node_modules_size_mb: integer("node_modules_size_mb"), // Size of node_modules in MB
    total_files: integer("total_files"), // Number of files in the snapshot

    // Status
    status: text("status")
      .$type<"creating" | "ready" | "expired" | "failed">()
      .default("creating")
      .notNull(),
    error_message: text("error_message"),

    // Timestamps
    created_at: timestamp("created_at").notNull().defaultNow(),
    expires_at: timestamp("expires_at").notNull(), // 7 days from creation
    last_used_at: timestamp("last_used_at"),

    // Usage tracking
    usage_count: integer("usage_count").default(0).notNull(),
  },
  (table) => ({
    template_key_idx: index("sandbox_snapshots_template_key_idx").on(
      table.template_key,
    ),
    status_idx: index("sandbox_snapshots_status_idx").on(table.status),
    expires_at_idx: index("sandbox_snapshots_expires_at_idx").on(
      table.expires_at,
    ),
    snapshot_id_idx: index("sandbox_snapshots_snapshot_id_idx").on(
      table.snapshot_id,
    ),
  }),
);

export type SandboxTemplateSnapshot = InferSelectModel<
  typeof sandboxTemplateSnapshots
>;
export type NewSandboxTemplateSnapshot = InferInsertModel<
  typeof sandboxTemplateSnapshots
>;
