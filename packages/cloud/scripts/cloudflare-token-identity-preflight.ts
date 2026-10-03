/**
 * Identifies the protected Cloudflare token using two fixed verification endpoints.
 * Only validated token status and a SHA-256 token-ID digest leave this boundary;
 * the digest identifies metadata, not permission scope or account ownership.
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const ORIGIN = "https://api.cloudflare.com/client/v4";
const ID = /^[a-f0-9]{32}$/;
const MAX_BYTES = 16_384;
const DEADLINE_MS = 10_000;

function diagnostic(
  endpoint,
  httpStatus,
  failure,
  status = null,
  tokenIdSha256 = null,
) {
  return Object.freeze({
    endpoint,
    httpStatus,
    failure,
    status,
    tokenIdSha256,
  });
}

/** Validates one bounded response; no upstream diagnostic text is returned or thrown. */
export async function verifyTokenIdentity({
  endpoint,
  token,
  accountId,
  fetchImpl = fetch,
  deadlineMs = DEADLINE_MS,
}) {
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
  let httpStatus = null;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(diagnostic(endpoint, httpStatus, "timeout"));
    }, deadlineMs);
  });
  const operation = async () => {
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
      const chunks = [];
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
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        // error-policy:J3 Malformed upstream bytes produce only a fixed failure category.
        return diagnostic(endpoint, httpStatus, "invalid_response");
      }
      if (
        body?.success !== true ||
        !body.result ||
        typeof body.result !== "object" ||
        typeof body.result.id !== "string" ||
        !ID.test(body.result.id) ||
        !["active", "disabled", "expired"].includes(body.result.status)
      ) {
        return diagnostic(endpoint, httpStatus, "invalid_response");
      }
      return diagnostic(
        endpoint,
        httpStatus,
        null,
        body.result.status,
        createHash("sha256").update(body.result.id, "utf8").digest("hex"),
      );
    } catch {
      // error-policy:J1 Neither fetch exceptions nor their nested causes cross this boundary.
      return diagnostic(
        endpoint,
        httpStatus,
        controller.signal.aborted ? "timeout" : "request_failed",
      );
    }
  };
  try {
    return await Promise.race([operation(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs only the two verification GETs, independently of every model certification producer. */
export async function runTokenIdentityPreflight({
  token,
  accountId,
  fetchImpl = fetch,
}) {
  const results = [];
  for (const endpoint of ["user", "account"]) {
    results.push(
      await verifyTokenIdentity({ endpoint, token, accountId, fetchImpl }),
    );
  }
  return results;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const results = await runTokenIdentityPreflight({
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: Direct protected CLI invocation is never Turbo-cached.
    token: process.env.CLOUDFLARE_API_TOKEN,
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: Direct protected CLI invocation is never Turbo-cached.
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  });
  for (const result of results)
    process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = results.some((result) => result.tokenIdSha256 !== null)
    ? 0
    : 1;
}
