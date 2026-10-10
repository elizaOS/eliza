/**
 * Browser-safe binding helpers for vault UIs. Native code re-validates every value; these
 * helpers only give the user immediate, identical feedback. No secrets are handled here.
 */
import type { PasswordEntrySummary } from "./definitions";

export class PasswordBindingError extends Error {
  readonly code = "invalid";
}

/**
 * Normalizes user input to an exact HTTPS origin, matching the native `PasswordFacets.web`
 * output. A bare host gets `https://`; a pasted page address keeps only its origin.
 * HTTP, user info and non-hostname inputs are refused rather than upgraded.
 */
export function normalizeWebsite(input: string): string {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text || text.length > 512)
    throw new PasswordBindingError("Enter a website address.");
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text)
    ? text
    : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new PasswordBindingError("Enter a website address.");
  }
  if (url.protocol !== "https:")
    throw new PasswordBindingError("Use an HTTPS website address.");
  if (url.username || url.password)
    throw new PasswordBindingError("Remove the user name from the address.");
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (
    !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
      host,
    ) ||
    host.length > 253
  )
    throw new PasswordBindingError("Enter a website address.");
  return `https://${host}${url.port ? `:${url.port}` : ""}`;
}

export function bindingKind(facet: string): "web" | "android" | null {
  if (typeof facet !== "string") return null;
  if (
    /^android:\/\/[a-f0-9]{64}@[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(
      facet,
    )
  )
    return "android";
  if (/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/.test(facet)) return "web";
  return null;
}

/** Case-insensitive search over labels, usernames and binding names. */
export function filterEntries(
  entries: readonly PasswordEntrySummary[],
  query: string,
): PasswordEntrySummary[] {
  const needle = (query || "").trim().toLowerCase();
  const sorted = [...entries].sort(
    (a, b) =>
      a.label.localeCompare(b.label) || a.username.localeCompare(b.username),
  );
  if (!needle) return sorted;
  return sorted.filter((entry) =>
    [
      entry.label,
      entry.username,
      ...entry.bindings.flatMap((binding) => [binding.display, binding.facet]),
    ].some((value) => value.toLowerCase().includes(needle)),
  );
}
