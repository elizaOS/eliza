/** Keeps a repeated OS-delivered remote URL from erasing this device's paired session. */

export function isAlreadyPairedRemoteTarget(
  target: URL,
  active: {
    kind: string;
    apiBase?: string;
    accessToken?: string;
  } | null,
): boolean {
  if (active?.kind !== "remote" || !active.apiBase || !active.accessToken)
    return false;
  try {
    return new URL(active.apiBase).href === target.href;
  } catch {
    return false;
  }
}
