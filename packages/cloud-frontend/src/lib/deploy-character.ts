/**
 * Module-level store for character-to-agent deploy requests.
 *
 * The "/dashboard/my-agents" page needs to tell the "/dashboard/agents"
 * page which character to pre-select when opening the create dialog.
 * URL params are fragile (encoding, setTimeout cleanup). React context
 * doesn't survive route changes. This module-level variable persists
 * across page mounts within the same SPA session without any of that.
 */

let _pendingCharacterId: string | null = null;

/** Call before navigating to `/dashboard/agents` to request a pre-selected character. */
export function requestDeployCharacter(characterId: string): void {
  _pendingCharacterId = characterId;
}

/** Call once on mount (or dialog open) to claim the pending request. */
export function consumeDeployCharacterRequest(): string | null {
  const id = _pendingCharacterId;
  _pendingCharacterId = null;
  return id;
}
