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

export function getProvenanceFlags(source: ProvenanceSource): ProvenanceFlags {
  const isThirdParty =
    source.thirdParty === true || source.origin === "third-party";
  const isBuiltIn = source.builtIn === true || source.origin === "builtin";
  const isFirstParty =
    source.firstParty === true || source.support === "first-party";
  const isCommunity =
    source.support === "community" || (isThirdParty && !isFirstParty);
  return { isThirdParty, isBuiltIn, isFirstParty, isCommunity };
}

/**
 * Tooltip text shown on provenance badges.
 *
 * `noun` differentiates the copy used by the apps catalog ("app") from the
 * copy used by the plugin/connector surfaces ("package"). Both surfaces have
 * always shown subtly different wording — preserved here intentionally.
 */
export function getProvenanceTitle(
  flags: ProvenanceFlags,
  noun: "app" | "package",
): string | undefined {
  if (flags.isThirdParty) {
    return noun === "app"
      ? "Community app registered through the plugin registry"
      : "Community package registered through the plugin registry";
  }
  if (flags.isBuiltIn || flags.isFirstParty) {
    return noun === "app"
      ? "First-party app generated from the elizaOS plugin registry"
      : "First-party package generated from the elizaOS plugin registry";
  }
  return undefined;
}
