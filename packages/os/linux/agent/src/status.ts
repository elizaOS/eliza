// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * Wire shape for the agent status probe.
 *
 * Mirrors the variants in `crates/elizad/src/main.rs::AgentStatus`. Both
 * sides serialize as lowercase strings; the JSON object envelope wraps the
 * state plus optional metadata so future fields can be added without
 * breaking the v1 shape.
 *
 * Phase 1 added `network`: a hint the shell uses to display a discreet
 * "offline — say `list wifi`" banner. It's `undefined` (NOT false) when
 * we couldn't probe — that's "we don't know," distinct from "offline."
 */

export type AgentStatus = "booting" | "ready" | "crashed";

export interface AgentStatusResponse {
    /** Schema version for forward compatibility. Bump on shape change. */
    schema_version: 1;
    /** Current supervisor-visible state. */
    state: AgentStatus;
    /**
     * Network reachability hint. `true` when nmcli reports an active
     * IPv4 address that isn't loopback; `false` when nmcli reports
     * offline; omitted when nmcli isn't available (host dev mode).
     */
    network?: { online: boolean; ssid?: string };
}

export function agentStatusResponse(state: AgentStatus): AgentStatusResponse {
    return { schema_version: 1, state };
}
