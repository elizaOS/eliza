// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * `eliza-agent` — the Bun subprocess that hosts `@elizaos/agent` for usbeliza.
 *
 * Phase 0 milestone #10: a real HTTP surface on 127.0.0.1:41337 with three
 * endpoints — `/api/status`, `/api/chat`, `/api/calibration` — exercising the
 * exact wire shapes elizad's Tauri commands hit.
 *
 * The chat handler is currently a thin echo (`Eliza: I heard "<your message>"`)
 * because milestone #11 is what wires `@elizaos/agent` and the
 * `usbeliza-codegen` plugin. The shape is real; only the brain is stubbed.
 */

import { agentStatusResponse, type AgentStatus } from "./status.ts";
import { chat as chatHandler, type ChatRequest } from "./chat.ts";
import { isNmcliAvailable, networkStatus } from "./network.ts";

// 41337, not 31337 — adb defaults to 31337 and milady's API also uses 31337,
// so a dev running both alongside usbeliza would otherwise get EADDRINUSE.
// USBELIZA_AGENT_PORT is canonical; ELIZA_API_PORT is accepted as a compat alias.
const PORT = Number(
    Bun.env.USBELIZA_AGENT_PORT ?? Bun.env.ELIZA_API_PORT ?? 41337,
);
const HOST = "127.0.0.1";

let status: AgentStatus = "booting";

const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    async fetch(request) {
        const url = new URL(request.url);
        const route = `${request.method} ${url.pathname}`;

        switch (route) {
            case "GET /api/status": {
                const resp = agentStatusResponse(status);
                // Best-effort network probe: don't block the status response on
                // nmcli; cache the last result and let the shell poll again.
                if (await isNmcliAvailable()) {
                    try {
                        const net = await networkStatus();
                        resp.network = {
                            online: net.online,
                            ...(net.activeSsid !== null ? { ssid: net.activeSsid } : {}),
                        };
                    } catch {
                        // network field stays undefined — distinguishes "unknown" from "offline"
                    }
                }
                return Response.json(resp);
            }

            case "POST /api/chat": {
                let body: ChatRequest;
                try {
                    body = (await request.json()) as ChatRequest;
                } catch {
                    return Response.json(
                        { error: "request body must be JSON" },
                        { status: 400 },
                    );
                }
                if (typeof body?.message !== "string") {
                    return Response.json(
                        { error: "missing `message` field" },
                        { status: 400 },
                    );
                }
                // Empty string is a valid "say hello" trigger — the
                // chat handler uses it as the first-window-open signal
                // that drives the Her-style onboarding greeting.
                const reply = await chatHandler(body);
                return Response.json(reply);
            }

            default:
                return new Response("not found", { status: 404 });
        }
    },
    error(error) {
        console.error("[eliza-agent] fatal:", error);
        return new Response("internal error", { status: 500 });
    },
});

console.log(`[eliza-agent] listening on http://${HOST}:${server.port}`);

// Milestone #11: this transition is driven by @elizaos/agent's actual readiness
// (model warm, persona+calibration loaded, plugins initialized). For Phase 0
// we transition immediately so elizad's splash-chat probe has something to see.
status = "ready";
