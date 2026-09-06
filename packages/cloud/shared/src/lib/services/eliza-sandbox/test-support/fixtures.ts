/** Provides explicit fixtures fixtures for deterministic sandbox orchestration tests. Importing this module installs no hooks, spies, or lifecycle simulation. */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { AgentSandbox } from "../../../../db/repositories/agent-sandboxes";

export function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function fetchHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}

export function customSandbox(): AgentSandbox {
  const now = new Date("2026-06-04T12:00:00.000Z");
  return {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    organization_id: "22222222-2222-4222-8222-222222222222",
    user_id: "33333333-3333-4333-8333-333333333333",
    character_id: null,
    sandbox_id: "sandbox-e06bb509",
    status: "running",
    deletion_attempt_id: null,
    deletion_started_at: null,
    deletion_previous_status: null,
    deletion_previous_billing_status: null,
    deletion_previous_shutdown_warning_sent_at: null,
    deletion_previous_scheduled_shutdown_at: null,
    pre_delete_capture_waiver_attempt_id: null,
    pre_delete_capture_waiver_environment_revision: null,
    pre_delete_capture_waiver_sandbox_id: null,
    pre_delete_capture_waiver_bridge_url: null,
    execution_tier: "custom",
    bridge_url: "https://legacy-bridge.example",
    health_url: "https://legacy-bridge.example/health",
    agent_name: "bnancy",
    agent_config: {},
    database_uri: "postgres://agent-db.example",
    database_status: "ready",
    database_error: null,
    snapshot_id: null,
    last_backup_at: null,
    last_heartbeat_at: null,
    error_message: null,
    error_count: 0,
    environment_vars: { ELIZA_API_TOKEN: "agent-token" },
    environment_revision: 0,
    lifecycle_revision: 0,
    node_id: "node-1",
    container_name: "agent-e06bb509",
    bridge_port: 18923,
    web_ui_port: 23816,
    headscale_ip: "100.64.0.10",
    docker_image: "ghcr.io/example/bnancy:latest",
    image_digest: null,
    previous_image_digest: null,
    previous_docker_image: null,
    billing_status: "active",
    last_billed_at: null,
    hourly_rate: "0.0100",
    total_billed: "0.00",
    shutdown_warning_sent_at: null,
    scheduled_shutdown_at: null,
    pool_status: null,
    pool_ready_at: null,
    claimed_at: null,
    warm_claim_credential_state: null,
    warm_claim_source_pool_id: null,
    warm_claim_key_fingerprint: null,
    warm_claim_attested_at: null,
    warm_claim_attested_environment_revision: null,
    warm_claim_cleanup_completed_at: null,
    replacement_cleanup_sandbox_id: null,
    replacement_cleanup_node_id: null,
    replacement_cleanup_container_name: null,
    replacement_cleanup_attempt_id: null,
    replacement_cleanup_container_id: null,
    replacement_cleanup_vpn_node_id: null,
    replacement_cleanup_vpn_node_name: null,
    replacement_cleanup_preserved_vpn_node_id: null,
    replacement_cleanup_vpn_registration_started_at: null,
    replacement_cleanup_allocation_counted: null,
    replacement_cleanup_created_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

export function sharedSandbox(): AgentSandbox {
  return {
    ...customSandbox(),
    sandbox_id: null,
    execution_tier: "shared",
    bridge_url: null,
    health_url: null,
    agent_name: "shared-nancy",
    agent_config: { system: "You are shared-nancy." },
    environment_vars: {},
    node_id: null,
    container_name: null,
    bridge_port: null,
    web_ui_port: null,
    headscale_ip: null,
    docker_image: null,
  };
}

// Compile a drizzle SQL object to its bound parameter list so a test can assert
// the values an UPDATE writes without coupling to SQL text. PgDialect.sqlToQuery
// returns exactly the bound params in order (same introspection the enqueue
// tests use).
export function sqlBoundParams(query: unknown): unknown[] {
  if (!query || typeof query !== "object" || !("queryChunks" in query)) return [];
  return new PgDialect().sqlToQuery(query as SQL).params;
}
