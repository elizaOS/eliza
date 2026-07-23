/**
 * Isolate-local refusal memory shared by inference admission and balance hydration.
 *
 * A refused deferred charge blocks subsequent requests immediately. A successful
 * authoritative balance refresh clears the block; the TTL is the crash-safe
 * fallback when no refresh runs in this isolate.
 */

import { InMemoryLRUCache } from "../cache/in-memory-lru-cache";

const REFUSAL_TTL_MS = 60_000;
const refusedOrgs = new InMemoryLRUCache<true>(4096, REFUSAL_TTL_MS);

export function markOrgAdmissionRefused(organizationId: string): void {
  refusedOrgs.set(organizationId, true);
}

export function isOrgAdmissionRefused(organizationId: string): boolean {
  return refusedOrgs.get(organizationId) === true;
}

export function clearOrgAdmissionRefused(organizationId: string): void {
  refusedOrgs.delete(organizationId);
}

export function clearAllOrgAdmissionRefusals(): void {
  refusedOrgs.deleteByPrefix("");
}
