export type BrowserBridgeCompanionAuthCode =
  | "browser_bridge_companion_pairing_invalid"
  | "browser_bridge_companion_token_expired"
  | "browser_bridge_companion_token_revoked";

export type BrowserBridgeCompanionAuthFailure = {
  ok: false;
  code: BrowserBridgeCompanionAuthCode;
  message: string;
};

export type BrowserBridgeCompanionPendingToken = {
  hash: string;
  expiresAt: string | null;
};

export type BrowserBridgeCompanionCredentialLike = {
  companion: {
    pairingTokenExpiresAt?: string | null;
    pairingTokenRevokedAt?: string | null;
  };
  pairingTokenHash: string | null;
  pendingPairingTokens?: BrowserBridgeCompanionPendingToken[] | null;
  pendingPairingTokenHashes?: string[] | null;
} | null;

export type BrowserBridgeCompanionAuthSuccess = {
  ok: true;
  source: "active" | "pending";
  expiresAt: string | null;
  remainingPendingPairingTokens: BrowserBridgeCompanionPendingToken[];
};

export type BrowserBridgeCompanionAuthResult =
  | BrowserBridgeCompanionAuthSuccess
  | BrowserBridgeCompanionAuthFailure;

export function browserBridgeCompanionAuthFailure(
  code: BrowserBridgeCompanionAuthCode,
): BrowserBridgeCompanionAuthFailure {
  switch (code) {
    case "browser_bridge_companion_token_expired":
      return {
        ok: false,
        code,
        message: "browser companion pairing token is expired",
      };
    case "browser_bridge_companion_token_revoked":
      return {
        ok: false,
        code,
        message: "browser companion pairing token is revoked",
      };
    case "browser_bridge_companion_pairing_invalid":
      return {
        ok: false,
        code,
        message: "browser companion pairing is invalid",
      };
  }
}

function isoTimestampExpired(
  value: string | null | undefined,
  nowMs: number,
): boolean {
  if (!value) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

function pendingTokens(
  credential: Exclude<BrowserBridgeCompanionCredentialLike, null>,
): BrowserBridgeCompanionPendingToken[] {
  if (Array.isArray(credential.pendingPairingTokens)) {
    return credential.pendingPairingTokens.map((token) => ({
      hash: token.hash,
      expiresAt: token.expiresAt ?? null,
    }));
  }
  return (credential.pendingPairingTokenHashes ?? []).map((hash) => ({
    hash,
    expiresAt: null,
  }));
}

export function authenticateBrowserBridgeCompanionCredential(args: {
  credential: BrowserBridgeCompanionCredentialLike;
  pairingTokenHash: string;
  nowMs: number;
}): BrowserBridgeCompanionAuthResult {
  const { credential, pairingTokenHash, nowMs } = args;
  if (!credential) {
    return browserBridgeCompanionAuthFailure(
      "browser_bridge_companion_pairing_invalid",
    );
  }

  if (credential.pairingTokenHash === pairingTokenHash) {
    if (credential.companion.pairingTokenRevokedAt) {
      return browserBridgeCompanionAuthFailure(
        "browser_bridge_companion_token_revoked",
      );
    }
    if (
      isoTimestampExpired(credential.companion.pairingTokenExpiresAt, nowMs)
    ) {
      return browserBridgeCompanionAuthFailure(
        "browser_bridge_companion_token_expired",
      );
    }
    return {
      ok: true,
      source: "active",
      expiresAt: credential.companion.pairingTokenExpiresAt ?? null,
      remainingPendingPairingTokens: pendingTokens(credential),
    };
  }

  if (credential.companion.pairingTokenRevokedAt) {
    return browserBridgeCompanionAuthFailure(
      "browser_bridge_companion_token_revoked",
    );
  }

  const tokens = pendingTokens(credential);
  const pendingToken = tokens.find((token) => token.hash === pairingTokenHash);
  if (!pendingToken) {
    return browserBridgeCompanionAuthFailure(
      "browser_bridge_companion_pairing_invalid",
    );
  }
  if (isoTimestampExpired(pendingToken.expiresAt, nowMs)) {
    return browserBridgeCompanionAuthFailure(
      "browser_bridge_companion_token_expired",
    );
  }
  return {
    ok: true,
    source: "pending",
    expiresAt: pendingToken.expiresAt ?? null,
    remainingPendingPairingTokens: tokens.filter(
      (token) => token.hash !== pairingTokenHash,
    ),
  };
}
