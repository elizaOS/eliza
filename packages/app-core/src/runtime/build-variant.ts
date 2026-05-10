/**
 * Build variant — Mac App Store / Microsoft Store / Flathub vs direct download.
 *
 * The variant is set at signing time, NOT runtime-toggleable. It is read from
 * the `MILADY_BUILD_VARIANT` environment variable, which is baked in by the
 * desktop build orchestrator (see `packages/app-core/scripts/desktop-build.mjs`).
 *
 * - `"store"`: sandboxed distribution intended for Apple/Microsoft/Flathub
 *   stores. The macOS App Sandbox entitlement is wired in. Local agent
 *   execution is incompatible with store sandbox policy, so the runtime
 *   forces Cloud hosting mode.
 * - `"direct"` (default): unsandboxed power-user build distributed directly.
 *   Behaves the same as today — local, remote, and cloud hosting are all
 *   available.
 */

export const BUILD_VARIANTS = ["store", "direct"] as const;
export type BuildVariant = (typeof BUILD_VARIANTS)[number];

export const DEFAULT_BUILD_VARIANT: BuildVariant = "direct";

/**
 * Resolve the build variant on the Node/Bun side. Reads
 * `MILADY_BUILD_VARIANT` from the process environment. Unrecognized values
 * fall back to {@link DEFAULT_BUILD_VARIANT}.
 */
export function getBuildVariant(): BuildVariant {
  const raw = process.env.MILADY_BUILD_VARIANT;
  if (raw === "store") return "store";
  if (raw === "direct") return "direct";
  return DEFAULT_BUILD_VARIANT;
}

export function isStoreBuild(): boolean {
  return getBuildVariant() === "store";
}

export function isDirectBuild(): boolean {
  return getBuildVariant() === "direct";
}
