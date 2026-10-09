/** Purpose admitted only by the disclosed first-party Google connection flow. */
export const GOOGLE_PERSONAL_CONTEXT_PURPOSE = "personal_google_context_v1" as const;
export type GooglePersonalContextConsent = {
  purpose: typeof GOOGLE_PERSONAL_CONTEXT_PURPOSE;
  version: 1;
  features: Array<"gmail.read" | "calendar.read">;
  modelProcessing: "requested_content";
  backgroundImport: false;
};
export function googlePersonalContextConsent(): GooglePersonalContextConsent {
  return {
    purpose: GOOGLE_PERSONAL_CONTEXT_PURPOSE,
    version: 1,
    features: ["gmail.read", "calendar.read"],
    modelProcessing: "requested_content",
    backgroundImport: false,
  };
}
export function isGooglePersonalContextConsent(
  value: unknown,
): value is GooglePersonalContextConsent {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    c.purpose === GOOGLE_PERSONAL_CONTEXT_PURPOSE &&
    c.version === 1 &&
    c.modelProcessing === "requested_content" &&
    c.backgroundImport === false &&
    Array.isArray(c.features) &&
    c.features.length === 2 &&
    c.features.includes("gmail.read") &&
    c.features.includes("calendar.read")
  );
}
export function selectedGoogleContextConsent(
  preferences: string | null | undefined,
): (GooglePersonalContextConsent & { grantId: string }) | undefined {
  if (!preferences || preferences.length > 65_536) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(preferences);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const selected = (parsed as Record<string, unknown>).personalGoogleContext;
  if (!isGooglePersonalContextConsent(selected)) return undefined;
  const grantId = (selected as GooglePersonalContextConsent & { grantId?: unknown }).grantId;
  return typeof grantId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(grantId)
    ? { ...selected, grantId }
    : undefined;
}
