/**
 * OpenID Connect provider persistence: single-use authorization codes, the
 * signed-out authorization-request parking lot, and the frozen per-user
 * identifiers an external relying party keys accounts on.
 *
 * These live in Postgres — NOT the cache — for the same reason the SSO bridge
 * does (`./sso-bridge.ts`): the deployed Worker cache is Cloudflare KV, which
 * has no atomic operations, so it cannot deliver "this code is redeemed
 * exactly once". `DELETE … RETURNING` can.
 *
 * Rows never contain token material or a claim snapshot: a code stores only
 * the sha256 of the opaque value plus the user id it was issued for, and the
 * token endpoint rebuilds every claim from live user/org rows. A database dump
 * therefore yields no redeemable code and no user PII, and a user deactivated
 * inside the code window cannot complete the exchange.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

export const oidcAuthorizationCodes = pgTable(
  "oidc_authorization_codes",
  {
    /** sha256 hex of the full opaque code; the raw code is never stored. */
    code_hash: text("code_hash").primaryKey(),
    client_id: text("client_id").notNull(),
    /** `users.id` — the value emitted as the OIDC `sub`. */
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Steward subject of the authorizing session — logout-marker ordering input. */
    steward_user_id: text("steward_user_id").notNull(),
    /** Exact redirect_uri presented at authorize; re-compared at redemption. */
    redirect_uri: text("redirect_uri").notNull(),
    /** Space-delimited granted scopes, already intersected with the client's allowlist. */
    scope: text("scope").notNull(),
    /** Echoed into the ID token when the RP sent one. */
    nonce: text("nonce"),
    /** PKCE challenge (base64url of sha256(verifier)); method is S256 only. */
    code_challenge: text("code_challenge"),
    code_challenge_method: text("code_challenge_method"),
    /** Feeds the `auth_time` claim. */
    auth_time: timestamp("auth_time", { withTimezone: true }).notNull(),
    /** iat of the authorizing Steward session — logout-marker ordering input. */
    token_issued_at: timestamp("token_issued_at", { withTimezone: true }).notNull(),
    /** Code TTL (~60s); enforced in the claim's WHERE clause, purged opportunistically. */
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    expiresAtIdx: index("oidc_authorization_codes_expires_at_idx").on(table.expires_at),
  }),
);

/**
 * Validated authorization requests parked across the login round trip. The
 * SPA login page only accepts a same-origin `returnTo` path, so a signed-out
 * RP request cannot be carried through it as an absolute URL; it is stored
 * here and resumed by opaque id instead. Storing the ALREADY-VALIDATED request
 * also means the resume leg never re-parses attacker-controlled input.
 */
export const oidcAuthorizationRequests = pgTable(
  "oidc_authorization_requests",
  {
    /** sha256 hex of the opaque request id handed to the browser. */
    request_hash: text("request_hash").primaryKey(),
    client_id: text("client_id").notNull(),
    redirect_uri: text("redirect_uri").notNull(),
    scope: text("scope").notNull(),
    /** RP CSRF token, echoed verbatim on the final redirect. */
    state: text("state"),
    nonce: text("nonce"),
    code_challenge: text("code_challenge"),
    code_challenge_method: text("code_challenge_method"),
    /** Reserved for future request parameters (`prompt`, `max_age`, …). */
    extra: jsonb("extra").$type<Record<string, unknown>>(),
    /** Parking-lot TTL (~10 min) — one login round trip, not a session. */
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    expiresAtIdx: index("oidc_authorization_requests_expires_at_idx").on(table.expires_at),
  }),
);

/**
 * OIDC-owned identity extensions. Deliberately NOT columns on `users`: that
 * table is the hot auth path and is mid-way through a field-level-encryption
 * rollout, and `username` here is a permanent externally-visible identifier
 * this subsystem alone allocates and freezes.
 */
export const oidcUserProfiles = pgTable("oidc_user_profiles", {
  user_id: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /**
   * The frozen `preferred_username` / `nickname` claim value. Unique because
   * the relying party (Forgejo) turns it into a permanent account name; once
   * allocated it must never change or an account is orphaned.
   */
  username: text("username").notNull().unique(),
  /** `human` | `agent` | `service` — Steward policy branches on this. */
  account_kind: text("account_kind").notNull().default("human"),
  /** Optional explicit `eliza_actor_id`; defaults to the `sub` when unset. */
  actor_id: text("actor_id"),
  /** Optional explicit `eliza_agent_id` for agent-owned service accounts. */
  agent_id: text("agent_id"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OidcAuthorizationCode = InferSelectModel<typeof oidcAuthorizationCodes>;
export type NewOidcAuthorizationCode = InferInsertModel<typeof oidcAuthorizationCodes>;
export type OidcAuthorizationRequest = InferSelectModel<typeof oidcAuthorizationRequests>;
export type NewOidcAuthorizationRequest = InferInsertModel<typeof oidcAuthorizationRequests>;
export type OidcUserProfile = InferSelectModel<typeof oidcUserProfiles>;
export type NewOidcUserProfile = InferInsertModel<typeof oidcUserProfiles>;
