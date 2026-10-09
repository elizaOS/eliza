/**
 * Creates a stopped dstack TDX VM only after authenticating its release bytes.
 * The VMM response is a provisioning receipt, never evidence of hardware trust
 * or readiness. Ambiguous failures are not retried because CreateVm is not an
 * idempotent operation; operators must reconcile the VMM inventory first.
 */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { verifyConfidentialRelease } from "./confidential-release.ts";

const positiveUint32 = z.number().int().positive().max(4_294_967_295);
const requestSchema = z
  .object({
    endpoint: z.url(),
    agentId: z.uuid(),
    compose: z.string().min(1),
    osImageHash: z.string().regex(/^[a-f0-9]{64}$/),
    variant: z.literal("dstack-tdx"),
    notBefore: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    envelope: z.object({ payload: z.string(), signature: z.string() }).strict(),
    image: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    vcpu: positiveUint32,
    memory: positiveUint32,
    diskSize: positiveUint32,
    encryptedEnv: z.string().regex(/^(?:[a-f0-9]{2})+$/i),
    kmsUrls: z.array(z.url()).min(1),
  })
  .strict();

/** Validates before calling the real versioned VMM JSON endpoint. */
export async function provisionConfidentialVm(
  input: unknown,
  releaseAuthorityPem: string,
  options: { authorization?: string; signal?: AbortSignal } = {},
): Promise<{ vmId: string; appId: string; state: "created-stopped" }> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new ElizaError(
      "Restore TLS certificate verification before provisioning",
      {
        code: "CONFIDENTIAL_TLS_VERIFICATION_REQUIRED",
      },
    );
  }
  let request: z.output<typeof requestSchema>;
  try {
    request = requestSchema.parse(input);
  } catch (cause) {
    // error-policy:J3 Reject malformed inputs before creating any remote resource.
    throw new ElizaError("Invalid confidential VM provisioning request", {
      code: "CONFIDENTIAL_VM_REQUEST_INVALID",
      cause,
    });
  }
  const endpoint = new URL(request.endpoint);
  const local =
    endpoint.protocol === "http:" &&
    ["127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== "https:" && !local) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  ) {
    throw new ElizaError("Use an HTTPS VMM origin or a loopback SSH tunnel", {
      code: "CONFIDENTIAL_VMM_ENDPOINT_INVALID",
    });
  }
  for (const value of request.kmsUrls) {
    const kms = new URL(value);
    if (kms.protocol !== "https:" || kms.username || kms.password || kms.hash) {
      throw new ElizaError("KMS destinations must use authenticated HTTPS", {
        code: "CONFIDENTIAL_KMS_ENDPOINT_INVALID",
      });
    }
  }
  const identity = verifyConfidentialRelease(
    {
      agentId: request.agentId,
      compose: request.compose,
      osImageHash: request.osImageHash,
      variant: request.variant,
      notBefore: request.notBefore,
      expiresAt: request.expiresAt,
    },
    request.envelope,
    releaseAuthorityPem,
  );
  const body = JSON.stringify({
    name: `eliza-${request.agentId}`,
    image: request.image,
    compose_file: request.compose,
    app_id: identity.appId,
    vcpu: request.vcpu,
    memory: request.memory,
    disk_size: request.diskSize,
    encrypted_env: request.encryptedEnv,
    kms_urls: request.kmsUrls,
    ports: [],
    user_config: "{}",
    hugepages: false,
    pin_numa: false,
    stopped: true,
    no_tee: false,
    disk_prealloc: "full",
  });
  try {
    const response = await fetch(new URL("/prpc/CreateVm?json", endpoint), {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(options.authorization
          ? { Authorization: options.authorization }
          : {}),
      },
      body,
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("VMM response body unavailable");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (!response.ok) throw new Error("VMM rejected provisioning request");
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 65_536)
          throw new Error("VMM receipt exceeds protocol size limit");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const result = z
      .object({ id: z.uuid() })
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return { vmId: result.id, appId: identity.appId, state: "created-stopped" };
  } catch (cause) {
    // error-policy:J2 No automatic retry after an operation that may have created a VM.
    throw new ElizaError(
      "VM creation is unconfirmed; reconcile the VMM inventory before retrying",
      { code: "CONFIDENTIAL_VM_PROVISION_UNCONFIRMED", cause },
    );
  }
}
