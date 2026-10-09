import {
  CLOUD_RUNTIME_CLIENT,
  CLOUD_RUNTIME_MAX_BODY,
  CLOUD_RUNTIME_SCOPE,
  cloudRuntimeDigest,
  cloudRuntimeMethod,
  cloudRuntimeTarget,
} from "@elizaos/contracts";
import { resolveOidcConfig } from "../oidc/config";
import { mintOidcAccessToken } from "../oidc/tokens";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";

async function boundedBody(request: Request): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length") || 0) > CLOUD_RUNTIME_MAX_BODY)
    throw Error("Runtime body too large");
  const reader = request.clone().body?.getReader();
  if (!reader) return new Uint8Array();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  request.signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > CLOUD_RUNTIME_MAX_BODY) throw Error("Runtime body too large");
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    request.signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
/** Called only after exact database owner/org and dedicated agent admission. */
export async function mintCloudRuntimeProof(
  request: Request,
  agentId: string,
  ownerId: string,
  organizationId: string,
): Promise<string> {
  const env = getCloudAwareEnv();
  const config = resolveOidcConfig({
    OIDC_ENABLED: env.OIDC_ENABLED,
    OIDC_ISSUER_URL: env.OIDC_ISSUER_URL,
    ELIZA_ONBOARDING_LOGIN_APP_URL: env.ELIZA_ONBOARDING_LOGIN_APP_URL,
    ELIZA_CLOUD_URL: env.ELIZA_CLOUD_URL,
    NEXT_PUBLIC_APP_URL: env.NEXT_PUBLIC_APP_URL,
    OIDC_WALLET_EMAIL_DOMAIN: env.OIDC_WALLET_EMAIL_DOMAIN,
  });
  if (!config || !config.issuer.startsWith("https://"))
    throw Error("Cloud owner signing unavailable");
  const url = new URL(request.url),
    method = cloudRuntimeMethod(request.method),
    target = cloudRuntimeTarget(url.pathname + url.search);
  const bytes = method === "GET" ? new Uint8Array() : await boundedBody(request);
  request.signal.throwIfAborted();
  return mintOidcAccessToken({
    issuer: config.issuer,
    clientId: CLOUD_RUNTIME_CLIENT,
    subject: ownerId,
    audiences: [url.origin],
    scope: CLOUD_RUNTIME_SCOPE,
    ttlSeconds: 30,
    claims: {
      agent_id: agentId,
      organization_id: organizationId,
      request_id: crypto.randomUUID(),
      request_method: method,
      request_target: target,
      request_body_sha256: await cloudRuntimeDigest(bytes),
    },
  });
}
