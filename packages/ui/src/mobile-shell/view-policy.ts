/** Shared mobile discovery policy. Permissions and effect approval stay in each
 * provider; a tile only promises that this host has an implementation to open. */
export interface MobileViewPolicyContext {
  implemented: boolean;
  managedCloud: boolean;
  /** Verified, installed native adapters. A launcher flavour is not evidence. */
  nativeViews: ReadonlySet<string>;
  developer?: boolean;
  preview?: boolean;
}

export interface MobileViewPolicyPage {
  id: string;
  agentViewId?: string;
  availability?: "always" | "managed-cloud";
  viewKind?: "system" | "release" | "developer" | "preview";
}

export const MOBILE_NATIVE_VIEW_IDS: readonly string[] = Object.freeze([
  "phone",
  "messages",
  "contacts",
]);

export function mobileViewIsAvailable(
  page: MobileViewPolicyPage,
  context: MobileViewPolicyContext,
): boolean {
  if (!context.implemented) return false;
  if (page.availability === "managed-cloud" && !context.managedCloud)
    return false;
  const id = page.agentViewId ?? page.id;
  if (MOBILE_NATIVE_VIEW_IDS.includes(id) && !context.nativeViews.has(id))
    return false;
  if (page.viewKind === "developer" && !context.developer) return false;
  if (page.viewKind === "preview" && !context.preview) return false;
  return true;
}
