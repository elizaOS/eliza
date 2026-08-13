import { appModeOriginForApexHostname } from "../../app-mode/app-mode";

/**
 * Resolve the trusted app-host destination for `/join` on an apex console.
 * The app-mode pairing is an exact deployed-host allowlist, so previews,
 * localhost, per-agent hosts, and attacker-controlled suffixes cannot become
 * cross-origin navigation targets.
 */
export function resolveApexJoinHandoff(hostname: string): string | null {
  const appOrigin = appModeOriginForApexHostname(hostname);
  return appOrigin ? `${appOrigin}/join` : null;
}
