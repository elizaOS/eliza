/**
 * Shared AOSP renderer detection.
 *
 * The Android framework appends the framework marker `ElizaOS/<tag>` only on
 * Eliza-derived AOSP system images. White-label builds may append additional
 * brand markers, but they still carry this base marker.
 */
export declare function userAgentHasElizaOSMarker(userAgent: string | null | undefined): boolean;
export declare const isAospElizaUserAgent: typeof userAgentHasElizaOSMarker;
//# sourceMappingURL=aosp-user-agent.d.ts.map