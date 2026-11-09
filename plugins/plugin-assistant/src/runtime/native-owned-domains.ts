/**
 * Host setting naming the owner domains a native app store owns. A phone host
 * whose own Clock owns alarms, or whose own Reminders store owns reminders and
 * undated to-dos, lists them in ELIZA_NATIVE_OWNED_DOMAINS (comma separated).
 * The agent then withholds the matching owner surfaces at registration and
 * routes those requests to the reviewed device tools instead of the LifeOps
 * definitions or the TRIGGER scheduler.
 */
export type NativeOwnedDomain = "alarms" | "reminders" | "todos";

export const NATIVE_OWNED_DOMAINS_SETTING = "ELIZA_NATIVE_OWNED_DOMAINS";

const NATIVE_OWNED_DOMAIN_NAMES: ReadonlySet<string> = new Set([
  "alarms",
  "reminders",
  "todos",
]);

export function nativeOwnedDomains(
  env: Record<string, string | undefined> | undefined = typeof process ===
  "undefined"
    ? undefined
    : process.env,
): ReadonlySet<NativeOwnedDomain> {
  const raw = env?.[NATIVE_OWNED_DOMAINS_SETTING];
  const domains = new Set<NativeOwnedDomain>();
  for (const value of raw?.split(",") ?? []) {
    const name = value.trim().toLowerCase();
    if (NATIVE_OWNED_DOMAIN_NAMES.has(name))
      domains.add(name as NativeOwnedDomain);
  }
  return domains;
}
