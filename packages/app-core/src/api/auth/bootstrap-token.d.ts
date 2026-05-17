/**
 * Bootstrap-token verifier.
 *
 * The Eliza Cloud control plane mints an RS256-signed JWT, injects it as
 * `ELIZA_CLOUD_BOOTSTRAP_TOKEN`, and the user pastes the same value into the
 * dashboard exactly once. We verify here and reject everything that doesn't
 * match: wrong issuer, wrong container, expired, replayed, signed with the
 * wrong algorithm, or by an unknown key.
 *
 * Hard rule: this module fails closed. There is no `try { … } catch { return
 * { authenticated: true } }` shortcut. Any error path returns
 * `{ ok: false, reason }` and the caller MUST refuse the request.
 */
import type { RuntimeEnvRecord } from "@elizaos/shared";
import type { AuthStore } from "../../services/auth-store";
export declare const BOOTSTRAP_TOKEN_ALG = "RS256";
export declare const BOOTSTRAP_TOKEN_SCOPE = "bootstrap";
export interface BootstrapTokenClaims {
  iss: string;
  sub: string;
  containerId: string;
  scope: "bootstrap";
  iat: number;
  exp: number;
  jti: string;
}
export type VerifyBootstrapResult =
  | {
      ok: true;
      claims: BootstrapTokenClaims;
    }
  | {
      ok: false;
      reason: VerifyBootstrapFailureReason;
    };
export type VerifyBootstrapFailureReason =
  | "missing_issuer_env"
  | "missing_container_env"
  | "missing_token"
  | "jwks_fetch_failed"
  | "signature_invalid"
  | "alg_not_allowed"
  | "issuer_mismatch"
  | "claims_invalid"
  | "scope_mismatch"
  | "container_mismatch"
  | "expired"
  | "replay"
  | "store_error";
interface VerifyOptions {
  env?: RuntimeEnvRecord;
  authStore: AuthStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
}
/**
 * Verify a bootstrap token.
 *
 * On success the same `jti` is recorded as seen so a second presentation
 * fails immediately with `replay`. The caller must NOT call this twice for
 * the same exchange — `recordJtiSeen` is consumed atomically here.
 */
export declare function verifyBootstrapToken(
  token: string,
  options: VerifyOptions,
): Promise<VerifyBootstrapResult>;
//# sourceMappingURL=bootstrap-token.d.ts.map
