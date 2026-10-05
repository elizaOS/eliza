import type http from "node:http";
import type { AgentHttpRequestAuthorization } from "@elizaos/agent/runtime/host-bridge";
import {
  CLOUD_RUNTIME_CLIENT,
  CLOUD_RUNTIME_MAX_BODY,
  CLOUD_RUNTIME_SCOPE,
  cloudRuntimeDigest,
  cloudRuntimeMethod,
  cloudRuntimeTarget,
  setCloudRuntimeRequestIdentity,
} from "@elizaos/contracts";
import type { IAgentRuntime } from "@elizaos/core";
import { readRequestBodyBuffer } from "@elizaos/host";
import {
  createRemoteJWKSet,
  customFetch,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
import { authStoreForRuntime } from "../services/auth-store";
import { getCompatApiToken, getProvidedApiToken, tokenMatches } from "./auth";
import { deriveIdentityIdFromCloudUser } from "./auth-bootstrap-routes";

export interface CloudRuntimeOwnerConfig {
  issuer: string;
  jwksUrl: string;
  audience: string;
  algorithm: "ES256" | "RS256";
  agentId: string;
  ownerId: string;
  organizationId: string;
}
export function cloudRuntimeOwnerConfig(
  env: Record<string, string | undefined>,
): CloudRuntimeOwnerConfig | null {
  try {
    const issuer = env.ELIZA_CLOUD_OWNER_ISSUER!,
      jwksUrl = env.ELIZA_CLOUD_OWNER_JWKS_URL!,
      audience = env.ELIZA_CLOUD_OWNER_AUDIENCE!,
      algorithm = env.ELIZA_CLOUD_OWNER_ALGORITHM;
    if (
      new URL(issuer).origin !== issuer ||
      !issuer.startsWith("https://") ||
      jwksUrl !== issuer + "/.well-known/oidc/jwks.json" ||
      new URL(audience).origin !== audience ||
      !audience.startsWith("https://") ||
      !["ES256", "RS256"].includes(algorithm!)
    )
      return null;
    const agentId = env.ELIZA_CLOUD_AGENT_ID!,
      ownerId = env.ELIZA_CLOUD_OWNER_ID!,
      organizationId = env.ELIZA_CLOUD_ORGANIZATION_ID!;
    for (const value of [agentId, ownerId, organizationId])
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value,
        )
      )
        return null;
    return {
      issuer,
      jwksUrl,
      audience,
      algorithm: algorithm as "ES256" | "RS256",
      agentId,
      ownerId,
      organizationId,
    };
  } catch {
    return null;
  }
}
const resolvers = new Map<string, JWTVerifyGetKey>();
function resolver(config: CloudRuntimeOwnerConfig): JWTVerifyGetKey {
  let key = resolvers.get(config.jwksUrl);
  if (!key) {
    key = createRemoteJWKSet(new URL(config.jwksUrl), {
      cacheMaxAge: 30000,
      cooldownDuration: 1000,
      timeoutDuration: 5000,
      [customFetch]: (input, init) =>
        fetch(input, { ...init, redirect: "error" }),
    });
    resolvers.set(config.jwksUrl, key);
  }
  return key;
}
/** Only cryptographic request validation; key injection exists for local signed HTTP tests. */
export async function verifyCloudRuntimeOwnerProof(
  token: string,
  request: { method: string; target: string; body: Uint8Array },
  config: CloudRuntimeOwnerConfig,
  key: JWTVerifyGetKey = resolver(config),
) {
  const { payload, protectedHeader } = await jwtVerify(token, key, {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: [config.algorithm],
    typ: "at+jwt",
    maxTokenAge: 30,
    clockTolerance: 0,
  });
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (
    protectedHeader.typ !== "at+jwt" ||
    payload.client_id !== CLOUD_RUNTIME_CLIENT ||
    payload.scope !== CLOUD_RUNTIME_SCOPE ||
    audiences.length !== 2 ||
    !audiences.includes(CLOUD_RUNTIME_CLIENT) ||
    !audiences.includes(config.audience) ||
    payload.sub !== config.ownerId ||
    payload.organization_id !== config.organizationId ||
    payload.agent_id !== config.agentId ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    payload.exp - payload.iat > 30 ||
    payload.exp <= payload.iat ||
    typeof payload.request_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      payload.request_id,
    ) ||
    payload.request_method !== cloudRuntimeMethod(request.method) ||
    payload.request_target !== cloudRuntimeTarget(request.target) ||
    payload.request_body_sha256 !== (await cloudRuntimeDigest(request.body))
  )
    throw Error("Cloud owner proof mismatch");
  return {
    ownerId: config.ownerId,
    organizationId: config.organizationId,
    requestId: payload.request_id,
    issuer: config.issuer,
  };
}
const resolved = new WeakMap<
  http.IncomingMessage,
  Promise<AgentHttpRequestAuthorization>
>();
/** A proof failure is terminal, never a fallback to the shared container principal. */
export function resolveCloudRuntimeOwner(
  req: http.IncomingMessage,
  runtime: IAgentRuntime | null,
): Promise<AgentHttpRequestAuthorization> {
  const prior = resolved.get(req);
  if (prior) return prior;
  const pending = (async (): Promise<AgentHttpRequestAuthorization> => {
    try {
      const config = cloudRuntimeOwnerConfig(process.env),
        token = req.headers["x-eliza-cloud-owner-proof"],
        expected = getCompatApiToken(),
        provided = getProvidedApiToken(req);
      if (
        !config ||
        !runtime ||
        runtime.agentId !== config.agentId ||
        typeof token !== "string" ||
        token.length > 16384 ||
        !expected ||
        !provided ||
        !tokenMatches(expected, provided)
      )
        throw Error("Cloud owner unavailable");
      const method = (req.method || "GET").toUpperCase();
      if (
        method === "GET" &&
        (req.headers["transfer-encoding"] ||
          Number(req.headers["content-length"] || 0) !== 0)
      )
        throw Error("GET body refused");
      const body =
        method === "GET"
          ? new Uint8Array()
          : await readRequestBodyBuffer(req, {
              maxBytes: CLOUD_RUNTIME_MAX_BODY,
            });
      if (body === null || req.aborted) throw Error("Request ended");
      const verified = await verifyCloudRuntimeOwnerProof(
        token,
        { method, target: req.url || "", body },
        config,
      );
      if (req.aborted) throw Error("Request aborted");
      const store = authStoreForRuntime(runtime);
      if (
        !store ||
        !(await store.recordJtiSeen("cloud-runtime:" + verified.requestId))
      )
        throw Error("Replay or unavailable store");
      const identityId = deriveIdentityIdFromCloudUser(verified.ownerId);
      let identity = await store.findIdentity(identityId);
      if (!identity) {
        try {
          identity = await store.createIdentity({
            id: identityId,
            kind: "owner",
            displayName: "Cloud owner",
            createdAt: Date.now(),
            passwordHash: null,
            cloudUserId: verified.ownerId,
          });
        } catch {
          identity = await store.findIdentity(identityId);
        }
      }
      if (
        !identity ||
        identity.kind !== "owner" ||
        identity.cloudUserId !== verified.ownerId
      )
        throw Error("Cloud owner identity conflict");
      setCloudRuntimeRequestIdentity(req, identityId);
      // Cloud device clients receive session USER authority, never global owner bypass.
      return {
        ok: true,
        role: "USER",
        identityId,
        externalIdentity: {
          issuer: verified.issuer,
          subject: verified.ownerId,
          organizationId: verified.organizationId,
        },
      };
    } catch {
      return { ok: false, role: "NONE" };
    }
  })();
  resolved.set(req, pending);
  return pending;
}
