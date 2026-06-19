// Shared (non-component) data helpers for the contacts overlay. Kept out of
// ContactsAppView.tsx so that file exports only React components and stays
// Fast-Refresh-compatible. Used by both the view components and the view-bundle
// `interact` handler.

import { type ContactSummary, Contacts } from "@elizaos/capacitor-contacts";

export function matchesQuery(contact: ContactSummary, q: string): boolean {
  if (q.length === 0) return true;
  const needle = q.toLowerCase();
  if (contact.displayName.toLowerCase().includes(needle)) return true;
  if (
    contact.phoneNumbers.some((p: string) => p.toLowerCase().includes(needle))
  ) {
    return true;
  }
  if (
    contact.emailAddresses.some((e: string) => e.toLowerCase().includes(needle))
  ) {
    return true;
  }
  return false;
}

function normalizeContactsLimit(value: unknown, fallback = 200): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(500, Math.max(1, Math.trunc(value)));
}

export async function loadContactsState(options?: {
  query?: string;
  limit?: number;
}) {
  const query = options?.query?.trim() ?? "";
  const limit =
    typeof options?.limit === "number"
      ? normalizeContactsLimit(options.limit)
      : undefined;
  const result = await Contacts.listContacts({
    ...(query ? { query } : {}),
    ...(typeof limit === "number" ? { limit } : {}),
  });
  const contacts = query
    ? result.contacts.filter((contact) => matchesQuery(contact, query))
    : result.contacts;
  return {
    contacts,
    query,
    count: contacts.length,
  };
}
