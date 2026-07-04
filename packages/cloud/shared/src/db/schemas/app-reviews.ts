// Defines the app reviews Drizzle table shape used by cloud repositories and services.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { apps } from "./apps";
import { users } from "./users";

/**
 * Binary disposition of an automated app compliance review (#10732).
 *
 * The classifier answers exactly one question: would monetizing this app get us
 * banned by our payment providers (Stripe/OxaPay) or is it illegal under US
 * law? `allow` → the app may monetize; `ban` → it is rejected.
 */
export const appReviewDispositionEnum = pgEnum("app_review_disposition", ["allow", "ban"]);

export type AppReviewDisposition = "allow" | "ban";

/**
 * App compliance reviews — append-only audit log (#10732).
 *
 * One row is written per review run so a reviewer can reconstruct *why* an app
 * was allowed or banned without reading server logs: the exact document the
 * classifier saw (`content_hash`), the rubric version, the model, the
 * deterministic pre-filter result, the matched policy categories, and the
 * rationale. Rows are never mutated — the newest row for an app is the current
 * decision, mirrored onto `apps.review_status`.
 */
export const appReviews = pgTable(
  "app_reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    app_id: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),

    // Who triggered the review (owner submitting, or admin re-review). Null for
    // system-triggered re-reviews (material change).
    triggered_by_user_id: uuid("triggered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    // Binary decision.
    disposition: appReviewDispositionEnum("disposition").notNull(),

    // Policy categories the app matched (empty for a clean allow).
    matched_categories: jsonb("matched_categories").$type<string[]>().notNull().default([]),

    // Machine-readable + human-readable justification the creator sees.
    rationale: text("rationale").notNull(),

    // Whether the deterministic keyword pre-filter (not the LLM) produced the
    // ban — lets us audit how often the cheap path short-circuits the model.
    pre_filter_matched: boolean("pre_filter_matched").notNull().default(false),

    // Provenance for reproducibility.
    rubric_version: text("rubric_version").notNull(),
    model_provider: text("model_provider"),
    model: text("model"),

    // Hash of the review-relevant fields the classifier saw. A later mismatch
    // against `apps.review_content_hash` means the listing materially changed
    // and must be re-reviewed.
    content_hash: text("content_hash").notNull(),

    // The candidate document the classifier scored (redacted of secrets).
    candidate_document: text("candidate_document").notNull(),

    // Optional pointer to a captured live-model trajectory for this run.
    trajectory_ref: text("trajectory_ref"),

    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    app_idx: index("app_reviews_app_idx").on(table.app_id),
    app_created_idx: index("app_reviews_app_created_idx").on(table.app_id, table.created_at),
    disposition_idx: index("app_reviews_disposition_idx").on(table.disposition),
  }),
);

export type AppReview = InferSelectModel<typeof appReviews>;
export type NewAppReview = InferInsertModel<typeof appReviews>;
