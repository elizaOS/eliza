/**
 * Identifies the protected Cloudflare token using two fixed verification endpoints.
 * Defaults to validated status and a token-ID digest. An explicit diagnostic
 * also returns closed policy counts; these do not prove effective Worker access.
 * Token IDs, account selectors, raw policies and provider messages stay private.
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const ORIGIN = "https://api.cloudflare.com/client/v4";
const ID = /^[a-f0-9]{32}$/;
const MAX_BYTES = 16_384;
const DEADLINE_MS = 10_000;

type Endpoint = "user" | "account";
type Failure =
  | "invalid_configuration"
  | "http_error"
  | "invalid_response"
  | "response_too_large"
  | "timeout"
  | "request_failed"
  | "permission_names_unavailable";
const TOKEN_STATUSES = ["active", "disabled", "expired"] as const;
type TokenStatus = (typeof TOKEN_STATUSES)[number];
type PermissionReport = Readonly<{
  httpStatus: number | null;
  failure: Failure | null;
  policyCount: number | null;
  observabilityWriteAllowPolicyCount: number | null;
  observabilityWriteDenyPolicyCount: number | null;
  scope: "token_policy_metadata_only";
}>;
type IdentityReport = Readonly<{
  endpoint: Endpoint;
  httpStatus: number | null;
  failure: Failure | null;
  status: TokenStatus | null;
  tokenIdSha256: string | null;
  permissionReport?: PermissionReport;
}>;
type VerifyOptions = {
  endpoint: Endpoint;
  token: unknown;
  accountId?: unknown;
  fetchImpl?: typeof fetch;
  deadlineMs?: number;
  includePermissions?: boolean;
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diagnostic(
  endpoint: Endpoint,
  httpStatus: number | null,
  failure: Failure | null,
  status: TokenStatus | null = null,
  tokenIdSha256: string | null = null,
): IdentityReport {
  return Object.freeze({
    endpoint,
    httpStatus,
    failure,
    status,
    tokenIdSha256,
  });
}

function permissionDiagnostic(
  httpStatus: number | null,
  failure: Failure | null,
  counts: {
    policyCount: number;
    allow: number | null;
    deny: number | null;
  } | null = null,
): PermissionReport {
  return Object.freeze({
    httpStatus,
    failure,
    policyCount: counts?.policyCount ?? null,
    observabilityWriteAllowPolicyCount: counts?.allow ?? null,
    observabilityWriteDenyPolicyCount: counts?.deny ?? null,
    // A policy inventory does not establish effective access to a Worker.
    scope: "token_policy_metadata_only",
  });
}

async function readPermissionMetadata(
  response: Response,
  tokenId: string,
  controller: AbortController,
): Promise<PermissionReport> {
  if (!response.ok) {
    controller.abort();
    return permissionDiagnostic(response.status, "http_error");
  }
  if (!response.body)
    return permissionDiagnostic(response.status, "invalid_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      controller.abort();
      return permissionDiagnostic(response.status, "response_too_large");
    }
    chunks.push(value);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return permissionDiagnostic(response.status, "invalid_response");
  }
  const result = record(body) && record(body.result) ? body.result : undefined;
  const policies = result?.policies;
  if (
    !record(body) ||
    body.success !== true ||
    result?.id !== tokenId ||
    !Array.isArray(policies)
  )
    return permissionDiagnostic(response.status, "invalid_response");
  let allow = 0;
  let deny = 0;
  let namesUnavailable = false;
  for (const policy of policies) {
    if (
      !record(policy) ||
      typeof policy.id !== "string" ||
      !policy.id ||
      (policy.effect !== "allow" && policy.effect !== "deny") ||
      !Array.isArray(policy.permission_groups) ||
      !policy.resources ||
      typeof policy.resources !== "object" ||
      Array.isArray(policy.resources)
    )
      return permissionDiagnostic(response.status, "invalid_response");
    let hasObservabilityWrite = false;
    for (const group of policy.permission_groups) {
      if (!record(group) || typeof group.id !== "string" || !group.id)
        return permissionDiagnostic(response.status, "invalid_response");
      if (group.name === undefined) {
        namesUnavailable = true;
        continue;
      }
      if (typeof group.name !== "string" || !group.name)
        return permissionDiagnostic(response.status, "invalid_response");
      if (group.name === "Workers Observability Write")
        hasObservabilityWrite = true;
    }
    if (hasObservabilityWrite) {
      if (policy.effect === "allow") allow++;
      else deny++;
    }
  }
  if (namesUnavailable)
    return permissionDiagnostic(
      response.status,
      "permission_names_unavailable",
      { policyCount: policies.length, allow: null, deny: null },
    );
  return permissionDiagnostic(response.status, null, {
    policyCount: policies.length,
    allow,
    deny,
  });
}

/** Validates one bounded response; no upstream diagnostic text is returned or thrown. */
export async function verifyTokenIdentity({
  endpoint,
  token,
  accountId,
  fetchImpl = fetch,
  deadlineMs = DEADLINE_MS,
  includePermissions = false,
}: VerifyOptions): Promise<IdentityReport> {
  if (endpoint !== "user" && endpoint !== "account")
    throw new Error("Invalid verification endpoint category");
  if (
    typeof token !== "string" ||
    !token ||
    /\s/.test(token) ||
    (endpoint === "account" &&
      (typeof accountId !== "string" || !ID.test(accountId))) ||
    !Number.isInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > DEADLINE_MS
  ) {
    return diagnostic(endpoint, null, "invalid_configuration");
  }
  const controller = new AbortController();
  let httpStatus: number | null = null;
  let permissionHttpStatus: number | null = null;
  let knownIdentity: IdentityReport | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<IdentityReport>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(
        knownIdentity
          ? Object.freeze({
              ...knownIdentity,
              permissionReport: permissionDiagnostic(
                permissionHttpStatus,
                "timeout",
              ),
            })
          : diagnostic(endpoint, httpStatus, "timeout"),
      );
    }, deadlineMs);
  });
  const operation = async (): Promise<IdentityReport> => {
    try {
      const path =
        endpoint === "user"
          ? "/user/tokens/verify"
          : `/accounts/${accountId}/tokens/verify`;
      const response = await fetchImpl(`${ORIGIN}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: controller.signal,
      });
      httpStatus = response.status;
      if (!response.ok) {
        controller.abort();
        return diagnostic(endpoint, httpStatus, "http_error");
      }
      if (!response.body)
        return diagnostic(endpoint, httpStatus, "invalid_response");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          controller.abort();
          return diagnostic(endpoint, httpStatus, "response_too_large");
        }
        chunks.push(value);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        // error-policy:J3 Malformed upstream bytes produce only a fixed failure category.
        return diagnostic(endpoint, httpStatus, "invalid_response");
      }
      if (
        !record(body) ||
        body.success !== true ||
        !record(body.result) ||
        typeof body.result.id !== "string" ||
        !ID.test(body.result.id)
      ) {
        return diagnostic(endpoint, httpStatus, "invalid_response");
      }
      const verified = body.result;
      const status = TOKEN_STATUSES.find(
        (status) => status === verified.status,
      );
      if (!status) return diagnostic(endpoint, httpStatus, "invalid_response");
      knownIdentity = diagnostic(
        endpoint,
        httpStatus,
        null,
        status,
        createHash("sha256").update(body.result.id, "utf8").digest("hex"),
      );
      if (!includePermissions) return knownIdentity;
      const permissionPath =
        endpoint === "user"
          ? `/user/tokens/${body.result.id}`
          : `/accounts/${accountId}/tokens/${body.result.id}`;
      const permissionResponse = await fetchImpl(`${ORIGIN}${permissionPath}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: controller.signal,
      });
      permissionHttpStatus = permissionResponse.status;
      const permissionReport = await readPermissionMetadata(
        permissionResponse,
        body.result.id,
        controller,
      );
      return Object.freeze({ ...knownIdentity, permissionReport });
    } catch {
      // error-policy:J1 Neither fetch exceptions nor their nested causes cross this boundary.
      const failure = controller.signal.aborted ? "timeout" : "request_failed";
      return knownIdentity
        ? Object.freeze({
            ...knownIdentity,
            permissionReport: permissionDiagnostic(
              permissionHttpStatus,
              failure,
            ),
          })
        : diagnostic(endpoint, httpStatus, failure);
    }
  };
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Verifies two fixed identities; explicit policy reads use only each verified token selector. */
export async function runTokenIdentityPreflight({
  token,
  accountId,
  fetchImpl = fetch,
  includePermissions = false,
}: Omit<VerifyOptions, "endpoint" | "deadlineMs">): Promise<IdentityReport[]> {
  const results: IdentityReport[] = [];
  for (const endpoint of ["user", "account"] as const) {
    results.push(
      await verifyTokenIdentity({
        endpoint,
        token,
        accountId,
        fetchImpl,
        includePermissions,
      }),
    );
  }
  return results;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const includePermissions =
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: Protected diagnostic input is never Turbo-cached.
    process.env.CLOUDFLARE_TOKEN_PERMISSION_REPORT === "true";
  const results = await runTokenIdentityPreflight({
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: Direct protected CLI invocation is never Turbo-cached.
    token: process.env.CLOUDFLARE_API_TOKEN,
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: Direct protected CLI invocation is never Turbo-cached.
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    includePermissions,
  });
  for (const result of results)
    process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = results.some((result) =>
    includePermissions
      ? result.permissionReport?.failure === null
      : result.tokenIdSha256 !== null,
  )
    ? 0
    : 1;
}
