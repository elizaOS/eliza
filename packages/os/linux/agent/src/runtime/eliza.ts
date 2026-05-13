// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 NubsCarson and contributors

/**
 * AgentRuntime entry point for usbeliza.
 *
 * Mirrors the shape of milady's `eliza/packages/agent/src/runtime/eliza.ts`:
 * instantiate `AgentRuntime` with our character, register a local model
 * provider (Shaw's `node-llama-cpp`, see `local-llama-plugin.ts`), then
 * register the `usbelizaPlugin` (Actions for build/open/wifi/etc).
 *
 * Why a singleton: AgentRuntime carries state (memory, registries, model
 * provider). Every chat turn reuses the same runtime so plugin init runs
 * once.
 *
 * What's intentionally smaller than milady's runtime:
 *  - No `@elizaos/app-core` / Vault bootstrap (milady's vault holds tokens;
 *    we have no auth surface yet).
 *  - No `@elizaos/app-lifeops` / `@elizaos/app-companion` (milady-specific apps).
 *  - No autonomy / scheduling service (Phase 1.5).
 *  - No plugin-resolver (we statically import the 2 plugins we ship).
 *
 * Everything load-bearing — Character, Plugin, Action, AgentRuntime,
 * useModel(ModelType.TEXT_LARGE) — is the real @elizaos/core API.
 */

import { AgentRuntime, type Character, stringToUuid } from "@elizaos/core";

import { ELIZA } from "../characters/eliza.ts";
import { claudeCloudPlugin } from "./claude-cloud-plugin.ts";
import { localLlamaPlugin } from "./local-llama-plugin.ts";
import { usbelizaPlugin } from "./plugin.ts";

let _runtime: Promise<AgentRuntime> | null = null;

export function getRuntime(): Promise<AgentRuntime> {
    if (_runtime === null) {
        _runtime = createRuntime();
    }
    return _runtime;
}

async function createRuntime(): Promise<AgentRuntime> {
    // The `ELIZA` character is already shaped to satisfy elizaOS's
    // `CharacterSchema` (validated at module-load in characters/eliza.ts).
    // We pin a stable agentId so memory rows survive restarts of this
    // subprocess. v5 of the squashfs uses the same id; new builds inherit.
    const agentId = stringToUuid("usbeliza-eliza-v1");
    const character: Character = {
        ...(ELIZA as unknown as Character),
        settings: {
            // GGUF path for Shaw's llama.cpp stack. The chroot hook bakes
            // the model into /usr/share/usbeliza/models/ on the live ISO;
            // local-llama-plugin's `modelPath()` falls through to a dev
            // path under ~/.cache/usbeliza-models when env/setting is unset.
            LOCAL_LARGE_MODEL:
                Bun.env.LOCAL_LARGE_MODEL ??
                Bun.env.USBELIZA_GGUF ??
                "/usr/share/usbeliza/models/llama-3.2-1b-instruct-q4_k_m.gguf",
        },
    };

    const runtime = new AgentRuntime({
        agentId,
        character,
        // Three plugins is the entire surface. We do NOT pull @elizaos/plugin-
        // bootstrap — its Discord/Telegram-style default actions (NONE /
        // IGNORE / CONTINUE / FOLLOW_ROOM ...) would clutter the chat-box.
        // usbelizaPlugin owns the user-visible Actions; localLlamaPlugin
        // owns the local-1B TEXT_* model handlers; claudeCloudPlugin owns
        // the *higher-priority* TEXT_LARGE handler that takes over once
        // the user signs into Claude. Registration order matters: claude
        // is appended AFTER local-llama so even in priority-tie scenarios
        // (which shouldn't happen — claudeCloudPlugin pins priority=100)
        // claude wins the resolver. When `isSignedIn("claude")` returns
        // false the claude handler throws and core's outer try/catch (in
        // `rephraseAsEliza`) falls back to the preset string — see
        // claude-cloud-plugin.ts for the throw-vs-delegate rationale.
        plugins: [localLlamaPlugin, claudeCloudPlugin, usbelizaPlugin],
    });

    // No persistent DB on the live USB by default — the agent runs from the
    // squashfs and writes its conversation/working-memory into a tmpfs that
    // disappears at reboot (locked decision #19: persistence is opt-in via
    // LUKS). Once persistence is unlocked we'll register `@elizaos/plugin-sql`
    // with a path under `/home/eliza/.eliza/db/`.
    await runtime.initialize({ skipMigrations: true, allowNoDatabase: true });
    return runtime;
}
