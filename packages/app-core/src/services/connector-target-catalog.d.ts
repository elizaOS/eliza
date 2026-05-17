/**
 * Connector target catalog — surfaces the user's enabled connectors as
 * structured `TargetGroup`s so the workflow clarification UI can render
 * quick-pick servers, channels, recipients, and chats without making the
 * end-user paste raw IDs.
 *
 * Discord is the only wired source in slice 2. Slack, Telegram, and Gmail
 * are placeholders so the host can stack them onto this framework without
 * a route or UI rewrite.
 *
 * The Discord enumeration shares its 5-minute REST cache with the workflow
 * runtime-context provider when the host wires both with the same
 * `discordCache` instance — a "generate" call that already primed the
 * runtime-context cache pays no extra REST cost when the user picks.
 */
import { type DiscordSourceCache, type DiscordSourceLogger } from "./discord-target-source";
export interface TargetGroup {
    /** Connector platform: 'discord', 'slack', 'telegram', 'gmail', etc. */
    platform: string;
    /** Server / workspace / chat-collection id (e.g. Discord guild id). */
    groupId: string;
    /** Human-readable group name (e.g. "Cozy Devs"). */
    groupName: string;
    targets: TargetEntry[];
}
export interface TargetEntry {
    id: string;
    name: string;
    kind: "channel" | "recipient" | "chat";
}
export interface ListGroupsOptions {
    /** Restrict to a single platform (e.g. only Discord). */
    platform?: string;
    /** Restrict to a single group within the platform (e.g. one guild). */
    groupId?: string;
}
export interface ConnectorTargetCatalog {
    listGroups(opts?: ListGroupsOptions): Promise<TargetGroup[]>;
}
/**
 * Subset of the host config the catalog reads. Mirrors the runtime-context
 * provider's `ConnectorConfigLike` so a host can pass the same accessor
 * to both.
 */
export interface ConnectorConfigLike {
    connectors?: {
        discord?: {
            enabled?: boolean;
            token?: string;
        };
        telegram?: {
            enabled?: boolean;
            botToken?: string;
        };
        gmail?: {
            enabled?: boolean;
            email?: string;
        };
        slack?: {
            enabled?: boolean;
            accessToken?: string;
        };
    };
}
export interface ElizaConnectorTargetCatalogOptions {
    /** Re-read on every call so connector edits do not require a restart. */
    getConfig: () => ConnectorConfigLike;
    /** Test injection seam — defaults to fetch. */
    fetchImpl?: typeof fetch;
    /** Test injection seam — defaults to Date.now. */
    now?: () => number;
    /** Optional shared Discord cache (see runtime-context-provider). */
    discordCache?: DiscordSourceCache;
    /** Optional logger; warnings only. */
    logger?: DiscordSourceLogger;
}
export declare function createElizaConnectorTargetCatalog(options: ElizaConnectorTargetCatalogOptions): ConnectorTargetCatalog;
//# sourceMappingURL=connector-target-catalog.d.ts.map