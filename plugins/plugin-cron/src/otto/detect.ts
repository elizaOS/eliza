/**
 * @module otto/detect
 * @description Lightweight Otto payload detection. No heavy dependencies.
 */

/**
 * Check if a job payload uses Otto-specific kinds (systemEvent or agentTurn)
 * rather than base plugin kinds (prompt, action, event).
 */
export function isOttoPayload(payload: Record<string, unknown>): boolean {
  const kind = payload.kind;
  return kind === 'systemEvent' || kind === 'agentTurn';
}
