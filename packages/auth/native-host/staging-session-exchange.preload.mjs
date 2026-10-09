/**
 * Process-test preload: answers the staging acceptance fixture's requests with
 * Cloud's real single-use staging session code service (in-memory store) and
 * the exchange route's refusal mapping. The native grant is refused, so a run
 * that passes session PKCE stops at "native-grant".
 */
import { ssoBridgeRepository } from "../../cloud/shared/src/db/repositories/sso-bridge.ts";
import {
  consumeStagingSessionCode,
  issueStagingSessionCode,
  looksLikeStagingSessionChallenge,
  looksLikeStagingSessionCode,
} from "../../cloud/shared/src/lib/services/staging-session-exchange-codes.ts";

const codes = new Map();
ssoBridgeRepository.purgeExpiredCodes = async () => 0;
ssoBridgeRepository.insertCode = async (row) => {
  codes.set(row.code_hash, row);
  return row;
};
ssoBridgeRepository.claimCode = async (codeHash) => {
  const row = codes.get(codeHash);
  codes.delete(codeHash);
  return row;
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const issuedAt = Math.floor(Date.now() / 1000);

globalThis.fetch = async (input, init = {}) => {
  const { origin, pathname } = new URL(String(input));
  if (origin !== "https://api-staging.eliza.app") throw new Error("offline");
  const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
  switch (pathname) {
    case "/api/health":
      return json(200, { commit: process.env.GITHUB_SHA });
    case "/api/v1/user":
      return json(200, {
        success: true,
        id: "staging-user",
        organization: { id: "staging-org" },
      });
    // packages/cloud/api/auth/staging-session-exchange/route.ts
    case "/api/auth/staging-session-exchange/mint": {
      if (!looksLikeStagingSessionChallenge(body.codeChallenge))
        return json(400, {
          error: "Code challenge required",
          code: "missing_challenge",
        });
      const issued = await issueStagingSessionCode({
        claims: {
          userId: "staging-steward-user",
          tenantId: "staging-tenant",
          bridged: true,
          stagingSessionBinding: { apiKeyId: "staging-api-key" },
          issuedAt,
          expiration: issuedAt + 600,
        },
        codeChallenge: body.codeChallenge,
      });
      return json(200, { ok: true, ...issued });
    }
    case "/api/auth/staging-session-exchange/exchange": {
      if (!looksLikeStagingSessionCode(body.code))
        return json(400, { error: "Code required", code: "missing_code" });
      const record = await consumeStagingSessionCode(
        body.code,
        typeof body.codeVerifier === "string" ? body.codeVerifier : null,
      );
      return record?.claims.stagingSessionBinding
        ? json(200, { ok: true, token: "staging-session-token" })
        : json(401, { error: "Invalid or expired code", code: "invalid_code" });
    }
    default:
      return json(503, { error: "unavailable" });
  }
};
