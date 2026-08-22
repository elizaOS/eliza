/** Parses the revocable bearer credential presented by remote runtime hosts. */

import { isRemotePairingUuid } from "@/db/crypto/remote-pairing-code";

export interface RemoteHostCredential {
  hostId: string;
  token: string;
}

export function parseRemoteHostCredential(
  request: Request,
): RemoteHostCredential | null {
  const hostId = request.headers.get("x-remote-host-id")?.trim() ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer (rhost_v1_[A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!isRemotePairingUuid(hostId) || !match?.[1]) return null;
  return { hostId, token: match[1] };
}
