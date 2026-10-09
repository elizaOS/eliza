/**
 * Remote-mode pairing contract between a self-hosted agent (for example the
 * dstack-hosted Alpha agent) and the phone app.
 *
 * Endpoint/auth contract, all relative to the agent's HTTPS origin:
 *   GET  /api/health          public readiness probe
 *   GET  /api/auth/status     public; { required, pairingEnabled, instanceId }
 *   GET  /api/auth/pair-code  operator only (loopback or `Authorization:
 *                             Bearer <ELIZA_API_TOKEN>`); { code, expiresAt,
 *                             instanceId }
 *   POST /api/auth/pair       public, rate limited; { code, instanceId } →
 *                             { token, instanceId }. Codes are single use and
 *                             expire; a different instance is rejected (409).
 *   everything else           `Authorization: Bearer <token>`
 *
 * The pairing payload (QR or deep link) carries the origin, the one-time code
 * and the issuing instance, never a bearer token:
 *   <scheme>://remote/agent-pair?v=1&url=<https origin>&code=<code>&instance=<uuid>
 * Clients must still apply their own origin trust policy before connecting.
 */

export const REMOTE_AGENT_PAIRING_VERSION = 1;
export const REMOTE_AGENT_PAIRING_HOST = "remote";
export const REMOTE_AGENT_PAIRING_PATH = "/agent-pair";
export const REMOTE_AGENT_ENDPOINTS = {
  health: "/api/health",
  status: "/api/auth/status",
  pairCode: "/api/auth/pair-code",
  pair: "/api/auth/pair",
} as const;

export interface RemoteAgentPairingPayload {
  version: typeof REMOTE_AGENT_PAIRING_VERSION;
  /** HTTPS origin of the agent API, without a trailing slash. */
  apiBase: string;
  /** One-time pairing code, normalized to upper case. */
  code: string;
  /** Server process that issued the code. */
  instanceId: string;
}

const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){1,2}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_URI_LENGTH = 2_048;

/** Returns the canonical HTTPS origin, or null for anything that is not one. */
export function normalizeRemoteAgentOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // error-policy:J3 Untrusted pairing input that does not parse is not an origin.
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }
  return url.origin;
}

function normalizeCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  return PAIRING_CODE_PATTERN.test(code) ? code : null;
}

/** Builds the QR/deep-link payload; throws on any field outside the contract. */
export function buildRemoteAgentPairingUri(
  input: { apiBase: string; code: string; instanceId: string },
  urlScheme = "elizaos",
): string {
  const apiBase = normalizeRemoteAgentOrigin(input.apiBase);
  const code = normalizeCode(input.code);
  if (!apiBase || !code || !UUID_PATTERN.test(input.instanceId)) {
    throw new TypeError(
      "Remote agent pairing requires an HTTPS origin, a pairing code and an instance id",
    );
  }
  const params = new URLSearchParams({
    v: String(REMOTE_AGENT_PAIRING_VERSION),
    url: apiBase,
    code,
    instance: input.instanceId.toLowerCase(),
  });
  return `${urlScheme}://${REMOTE_AGENT_PAIRING_HOST}${REMOTE_AGENT_PAIRING_PATH}?${params}`;
}

/**
 * Parses the canonical payload. Unknown, duplicated or extra fields, bearer
 * tokens, non-HTTPS origins and unsupported versions fail closed (null).
 */
export function parseRemoteAgentPairingUri(
  rawUri: string,
  urlScheme = "elizaos",
): RemoteAgentPairingPayload | null {
  if (rawUri.length === 0 || rawUri.length > MAX_URI_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUri);
  } catch {
    // error-policy:J3 OS-delivered deep-link bytes are untrusted input.
    return null;
  }
  if (
    parsed.protocol !== `${urlScheme.toLowerCase()}:` ||
    parsed.host !== REMOTE_AGENT_PAIRING_HOST ||
    parsed.pathname !== REMOTE_AGENT_PAIRING_PATH ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash
  ) {
    return null;
  }
  const keys = [...parsed.searchParams.keys()];
  const expected = ["v", "url", "code", "instance"];
  if (
    keys.length !== expected.length ||
    expected.some((key) => parsed.searchParams.getAll(key).length !== 1)
  ) {
    return null;
  }
  if (parsed.searchParams.get("v") !== String(REMOTE_AGENT_PAIRING_VERSION)) {
    return null;
  }
  const apiBase = normalizeRemoteAgentOrigin(
    parsed.searchParams.get("url") ?? "",
  );
  const code = normalizeCode(parsed.searchParams.get("code") ?? "");
  const instanceId = parsed.searchParams.get("instance") ?? "";
  if (!apiBase || !code || !UUID_PATTERN.test(instanceId)) return null;
  return {
    version: REMOTE_AGENT_PAIRING_VERSION,
    apiBase,
    code,
    instanceId: instanceId.toLowerCase(),
  };
}
