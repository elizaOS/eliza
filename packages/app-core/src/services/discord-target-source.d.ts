/**
 * Discord target enumeration — shared by the workflow runtime-context provider
 * (which formats results as fact strings for the LLM prompt) and the
 * connector-target-catalog (which surfaces structured TargetGroup objects
 * for the clarification UI). Owning the REST + cache here means a single
 * 5-minute window covers both consumers; a dogfood "generate" that just
 * primed the runtime-context cache then asks the catalog for choices does
 * not double-fetch Discord.
 *
 * Network failures degrade silently — callers receive an empty array or a
 * `channelsError` marker on partial success, never a thrown rejection.
 */
export interface DiscordEnumerationResult {
    guildId: string;
    guildName: string;
    /** Text channels for this guild. Absent when channel enumeration failed. */
    channels?: Array<{
        id: string;
        name: string;
    }>;
    /** Present when channel enumeration failed for this specific guild. */
    channelsError?: {
        status?: number;
        message?: string;
    };
}
export type DiscordSourceCache = Map<string, {
    expiresAt: number;
    result: DiscordEnumerationResult[];
}>;
export interface DiscordSourceLogger {
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
}
export interface DiscordSourceOptions {
    fetchImpl?: typeof fetch;
    now?: () => number;
    cache?: DiscordSourceCache;
    logger?: DiscordSourceLogger;
}
export declare const DISCORD_FACT_CACHE_TTL_MS: number;
export declare function createDiscordSourceCache(): DiscordSourceCache;
/**
 * Enumerate the Discord bot's guilds and text channels. Cached per-token
 * for `DISCORD_FACT_CACHE_TTL_MS`. The cache is provided by the caller so
 * the runtime-context-provider and the catalog can share a single window.
 */
export declare function fetchDiscordEnumeration(botToken: string, options?: DiscordSourceOptions): Promise<DiscordEnumerationResult[]>;
/**
 * Format an enumeration result as the human-readable fact strings the workflow
 * runtime-context provider injects into the LLM prompt.
 */
export declare function formatDiscordEnumerationAsFacts(results: ReadonlyArray<DiscordEnumerationResult>): string[];
//# sourceMappingURL=discord-target-source.d.ts.map