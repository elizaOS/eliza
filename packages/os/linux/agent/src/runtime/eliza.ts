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
 * Why we don't call `bootElizaRuntime()` from @elizaos/agent like milady
 * does: that wrapper is ~600 lines designed for the full app context —
 * it requires `~/.eliza/eliza.json`, registers `@elizaos/plugin-sql`
 * (PGLite, ~50MB), runs the OS-keychain vault bootstrap, hydrates wallet
 * keys, applies x402/Discord/Telegram channel secrets, and so on. None of
 * those make sense on a stateless USB ISO that boots from squashfs into
 * tmpfs and disappears on shutdown. See docs/eliza-integration.md for
 * the full rationale + the migration path once we adopt LUKS persistence.
 *
 * What's intentionally smaller than milady's runtime:
 *  - No `@elizaos/app-core` / Vault bootstrap (milady's vault holds tokens;
 *    we have no auth surface yet).
 *  - No `@elizaos/app-lifeops` / `@elizaos/app-companion` (milady-specific apps).
 *  - No autonomy / scheduling service (Phase 1.5).
 *  - No `@elizaos/plugin-sql` (PGLite) — opt-in once LUKS persistence ships.
 *
 * Everything load-bearing — Character, Plugin, Action, AgentRuntime,
 * useModel(ModelType.TEXT_LARGE) — is the real @elizaos/core API.
 *
 * What we DO adopt from milady's pattern:
 *  - `PROVIDER_PLUGIN_MAP` (inlined from upstream — see the constant below
 *    for the resync note). Env-var → plugin auto-load: when the user
 *    exports `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc., the corresponding
 *    @elizaos/plugin-* gets dynamically imported + registered via
 *    `autoLoadProviderPlugins()`. Same pattern milady uses in its
 *    `plugin-collector` path.
 */

import {
    AgentRuntime,
    type Character,
    type Plugin,
    stringToUuid,
} from "@elizaos/core";

import { ELIZA } from "../characters/eliza.ts";
import { claudeCloudPlugin } from "./claude-cloud-plugin.ts";
import { localLlamaPlugin } from "./local-llama-plugin.ts";
import { usbelizaPlugin } from "./plugin.ts";

/**
 * Env-var → plugin-package mapping. **Synced verbatim from upstream**:
 * `eliza/packages/agent/src/runtime/plugin-collector.ts:136` (`PROVIDER_PLUGIN_MAP`).
 *
 * We inline rather than `import { PROVIDER_PLUGIN_MAP } from "@elizaos/agent"`
 * because importing from `@elizaos/agent` triggers its transitive module
 * loads (`@elizaos/plugin-browser-bridge`, `@elizaos/app-training`, the
 * SQL/vault bootstrap chain). Those packages exist in the elizaOS
 * monorepo workspace but not in our minimal-mode agent's `node_modules`,
 * so the import would crash boot. We only need this 20-entry constant —
 * not the runtime startup it sits next to. The map is small, public,
 * and a stable lookup table; a 5-line resync is cheaper than carrying
 * the full transitive surface.
 *
 * **Re-sync whenever upstream adds a new model provider** — a stale map
 * means a user's `<WHATEVER>_API_KEY` won't auto-load the new plugin.
 * As of 2026-05-13 (eliza develop @ commit 93d3afcbea), the table covers:
 * anthropic, openai, google-genai, groq, xai, openrouter, deepseek,
 * mistral, together, vercel-ai-gateway, ollama, mlx, zai, elizacloud.
 */
const PROVIDER_PLUGIN_MAP: Readonly<Record<string, string>> = {
    ANTHROPIC_API_KEY: "@elizaos/plugin-anthropic",
    OPENAI_API_KEY: "@elizaos/plugin-openai",
    GEMINI_API_KEY: "@elizaos/plugin-google-genai",
    GOOGLE_API_KEY: "@elizaos/plugin-google-genai",
    GOOGLE_GENERATIVE_AI_API_KEY: "@elizaos/plugin-google-genai",
    GROQ_API_KEY: "@elizaos/plugin-groq",
    XAI_API_KEY: "@elizaos/plugin-xai",
    OPENROUTER_API_KEY: "@elizaos/plugin-openrouter",
    DEEPSEEK_API_KEY: "@elizaos/plugin-deepseek",
    MISTRAL_API_KEY: "@elizaos/plugin-mistral",
    TOGETHER_API_KEY: "@elizaos/plugin-together",
    AI_GATEWAY_API_KEY: "@elizaos/plugin-vercel-ai-gateway",
    AIGATEWAY_API_KEY: "@elizaos/plugin-vercel-ai-gateway",
    OLLAMA_BASE_URL: "@elizaos/plugin-ollama",
    MLX_BASE_URL: "@elizaos/plugin-mlx",
    ZAI_API_KEY: "@elizaos/plugin-zai",
    Z_AI_API_KEY: "@elizaos/plugin-zai",
    ELIZAOS_CLOUD_API_KEY: "@elizaos/plugin-elizacloud",
    ELIZAOS_CLOUD_ENABLED: "@elizaos/plugin-elizacloud",
};

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
                "/usr/share/usbeliza/models/eliza-1-0_8b-32k.gguf",
        },
    };

    const runtime = new AgentRuntime({
        agentId,
        character,
        // Three plugins is the entire surface. We do NOT pull @elizaos/plugin-
        // bootstrap — its Discord/Telegram-style default actions (NONE /
        // IGNORE / CONTINUE / FOLLOW_ROOM ...) would clutter the chat-box.
        // usbelizaPlugin owns the user-visible Actions; localLlamaPlugin
        // owns the smallest Eliza-1 TEXT_* model handlers; claudeCloudPlugin owns
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

    // Auto-load any @elizaos/plugin-* the user opted into via env vars.
    // Runs AFTER initialize() so the base three plugins are wired first; any
    // late-registered provider plugin slots in via runtime.registerPlugin's
    // priority resolver. Failures are non-fatal — a missing optional plugin
    // package shouldn't gate the agent from booting.
    await autoLoadProviderPlugins(runtime);

    return runtime;
}

/**
 * Iterate Eliza's canonical PROVIDER_PLUGIN_MAP (ANTHROPIC_API_KEY →
 * @elizaos/plugin-anthropic, OPENAI_API_KEY → @elizaos/plugin-openai, etc.)
 * and dynamically register every plugin whose env-var sentinel is set in
 * process.env. Dynamic import means we don't have to bundle every cloud
 * provider — only the ones a user actually configures get loaded.
 *
 * Lifted verbatim from milady's `plugin-collector` pattern (packages/agent/
 * src/runtime/plugin-collector.ts:283 `collectPluginNames`). We don't call
 * `collectPluginNames` directly because it expects a full `ElizaConfig`
 * object (channels, cloud, features, vault, x402, …) — none of which we
 * carry in minimal mode. The map itself is the public-API primitive we
 * actually need.
 *
 * Soft-fail on each plugin: a missing package, an alpha-vs-beta version
 * mismatch on `@elizaos/core`, or a provider that throws during register
 * shouldn't gate the agent from booting. We log the cause so the user
 * sees why their key didn't take.
 */
async function autoLoadProviderPlugins(runtime: AgentRuntime): Promise<void> {
    const loaded = new Set<string>();
    for (const [envVar, packageName] of Object.entries(PROVIDER_PLUGIN_MAP)) {
        // Deduplicate when multiple env-vars map to the same plugin
        // (e.g. GOOGLE_API_KEY + GEMINI_API_KEY both → plugin-google-genai).
        if (loaded.has(packageName)) continue;
        const value = process.env[envVar];
        if (value === undefined || value === "") continue;
        try {
            const mod = (await import(packageName)) as
                | { default?: Plugin }
                | Record<string, unknown>;
            const plugin =
                (mod as { default?: Plugin }).default ??
                // Some plugins ship the Plugin object as a named export
                // matching the short name (e.g. `anthropicPlugin`). We
                // fall through to the first Plugin-shaped value we find.
                Object.values(mod).find(
                    (v): v is Plugin =>
                        typeof v === "object" &&
                        v !== null &&
                        typeof (v as Plugin).name === "string",
                );
            if (plugin === undefined) {
                process.stderr.write(
                    `[usbeliza] ${packageName}: imported but no Plugin export found\n`,
                );
                continue;
            }
            await runtime.registerPlugin(plugin);
            loaded.add(packageName);
            process.stderr.write(
                `[usbeliza] auto-loaded ${packageName} (env: ${envVar})\n`,
            );
        } catch (err) {
            // Plugin not installed, version-incompatible, or threw during
            // register. Skip silently to stderr — the agent boots without it.
            process.stderr.write(
                `[usbeliza] ${packageName} skipped: ${(err as Error).message}\n`,
            );
        }
    }
}
