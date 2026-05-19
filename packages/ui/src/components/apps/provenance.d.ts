/**
 * Shared provenance detection for apps and plugins.
 *
 * Apps (`RegistryAppInfo`) and plugins (`PluginInfo`) both expose the same
 * `thirdParty` / `builtIn` / `firstParty` / `origin` / `support` fields, and the
 * four UI surfaces that display provenance badges all derive the same four
 * booleans from those fields. Those callsites differ in label casing, badge
 * shape, and "app" vs "package" copy — but the underlying detection and the
 * tooltip text are identical, and live here as the single source of truth.
 *
 * Callers continue to format their own labels/badges (Title vs lowercase,
 * `className` vs `tone`) — only the detection and the tooltip are shared.
 */
export interface ProvenanceSource {
    thirdParty?: boolean;
    builtIn?: boolean;
    firstParty?: boolean;
    origin?: string;
    support?: string;
}
export interface ProvenanceFlags {
    isThirdParty: boolean;
    isBuiltIn: boolean;
    isFirstParty: boolean;
    isCommunity: boolean;
}
export declare function getProvenanceFlags(source: ProvenanceSource): ProvenanceFlags;
/**
 * Tooltip text shown on provenance badges.
 *
 * `noun` differentiates the copy used by the apps catalog ("app") from the
 * copy used by the plugin/connector surfaces ("package"). Both surfaces have
 * always shown subtly different wording — preserved here intentionally.
 */
export declare function getProvenanceTitle(flags: ProvenanceFlags, noun: "app" | "package"): string | undefined;
//# sourceMappingURL=provenance.d.ts.map