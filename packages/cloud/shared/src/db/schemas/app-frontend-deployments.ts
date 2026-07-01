/**
 * App Frontend Deployments Schema
 *
 * First-class managed frontend hosting for Cloud apps. Each row is an
 * immutable, content-addressed static-site deployment whose artifacts live in
 * R2 under `r2_prefix`. Exactly one deployment per app is `is_active` at a time
 * (partial unique index); activating another one is an atomic swap, which also
 * gives free rollback (activate an older deployment).
 *
 * The Cloud Worker serves the active deployment's files from R2 at the app's
 * system frontend host / verified custom domain, injecting SEO metadata and a
 * page-view analytics beacon at response time (things Cloud cannot do while an
 * app only carries an external `app_url`). See
 * `packages/cloud/shared/src/lib/services/app-frontend-hosting.ts`.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { users } from "./users";

/**
 * Deployment lifecycle:
 *   pending   → created, awaiting artifacts
 *   uploading → artifacts being written to R2
 *   ready     → finalized + manifest validated; servable but not live
 *   active    → the live deployment for the app (at most one per app)
 *   superseded→ was active, replaced by a newer activation (kept for rollback)
 *   failed    → finalize/validation failed
 */
export type FrontendDeploymentStatus =
  | "pending"
  | "uploading"
  | "ready"
  | "active"
  | "superseded"
  | "failed";

/** One file in a deployment's manifest. */
export interface FrontendFileEntry {
  /** POSIX path relative to the site root, no leading slash (e.g. "index.html", "assets/app.js"). */
  path: string;
  /** sha256 hex of the file bytes; the R2 object key is `${r2_prefix}${hash}`. */
  hash: string;
  /** Content-Type served to clients. */
  contentType: string;
  /** Byte length of the stored object. */
  size: number;
}

/** Validated file manifest for a finalized deployment. */
export interface FrontendManifest {
  files: FrontendFileEntry[];
  /** Document served for "/" and (when spaFallback) unmatched routes. */
  entrypoint: string;
  /** When true, unmatched non-asset paths fall back to the entrypoint (SPA client routing). */
  spaFallback: boolean;
}

/** Provenance for a deployment (who/what built it). */
export interface FrontendBuildMeta {
  /** "upload" | "agent" | "github" | "cli" … free-form source tag. */
  source?: string | null;
  framework?: string | null;
  gitCommit?: string | null;
  note?: string | null;
}

export const appFrontendDeployments = pgTable(
  "app_frontend_deployments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),

    /** Monotonic per-app version for display + rollback ordering. */
    version: integer("version").notNull(),

    status: text("status").$type<FrontendDeploymentStatus>().notNull().default("pending"),

    /** R2 object-key prefix under which this deployment's immutable artifacts live. */
    r2_prefix: text("r2_prefix").notNull(),

    /** Validated file manifest (populated at finalize). */
    manifest: jsonb("manifest").$type<FrontendManifest | null>(),

    /** sha256 over the sorted manifest — dedupe + change detection (re-review triggers). */
    content_hash: text("content_hash"),

    file_count: integer("file_count").notNull().default(0),
    total_bytes: integer("total_bytes").notNull().default(0),

    build_meta: jsonb("build_meta").$type<FrontendBuildMeta>().notNull().default({}),

    error: text("error"),

    created_by_user_id: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
    finalized_at: timestamp("finalized_at"),
    activated_at: timestamp("activated_at"),
  },
  (table) => ({
    app_id_idx: index("app_frontend_deployments_app_id_idx").on(table.app_id),
    app_version_idx: uniqueIndex("app_frontend_deployments_app_version_idx").on(
      table.app_id,
      table.version,
    ),
    /**
     * At most one ACTIVE deployment per app. Partial unique index on
     * (app_id) WHERE status = 'active' — the DB backstop for the single-active
     * invariant, so a racing activation cannot leave two live deployments.
     */
    app_active_idx: uniqueIndex("app_frontend_deployments_active_idx")
      .on(table.app_id)
      .where(sql`${table.status} = 'active'`),
  }),
);

export type AppFrontendDeployment = InferSelectModel<typeof appFrontendDeployments>;
export type NewAppFrontendDeployment = InferInsertModel<typeof appFrontendDeployments>;
