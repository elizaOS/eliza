export declare function getLocalizedConversationTitle(title: string | undefined | null, t: (key: string, vars?: Record<string, string | number | boolean | null | undefined>) => string): string;
export declare const BROWSER_CAPABILITY_PLUGIN_IDS: Set<string>;
export declare const COMPUTER_CAPABILITY_PLUGIN_IDS: Set<string>;
export declare function formatRelativeTime(dateString: string, t: (key: string, vars?: Record<string, string | number | boolean | null | undefined>) => string): string;
export declare function avatarIndexFromConversationId(id: string): number;
export declare function resolveProviderLabel(model: string | undefined): string;
export declare function isNonChatModelLabel(model: string | undefined): boolean;
export declare function estimateTokenCost(promptTokens: number, completionTokens: number, model: string | undefined): string;
//# sourceMappingURL=conversation-utils.d.ts.map