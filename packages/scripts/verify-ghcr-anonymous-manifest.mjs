/**
 * Proves that a published GHCR digest is anonymously readable and still
 * references the locally boot-verified image configuration.
 */

import { pathToFileURL } from "node:url";

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY_PATTERN = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;
const MANIFEST_ACCEPT = [
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
].join(", ");

export class GhcrVerificationError extends Error {
  constructor(message, { retryable = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GhcrVerificationError";
    this.retryable = retryable;
  }
}

export function parseCliArguments(argumentsList) {
  const allowedNames = new Set(["--repository", "--digest", "--image-id"]);
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!allowedNames.has(name) || !value || values.has(name)) {
      throw new GhcrVerificationError(
        "Expected one value each for --repository, --digest, and --image-id.",
      );
    }
    values.set(name, value);
  }
  if (values.size !== allowedNames.size) {
    throw new GhcrVerificationError(
      "Expected one value each for --repository, --digest, and --image-id.",
    );
  }
  return {
    repository: values.get("--repository"),
    digest: values.get("--digest"),
    imageId: values.get("--image-id"),
  };
}

function requireDigest(name, value) {
  if (!DIGEST_PATTERN.test(value ?? "")) {
    throw new GhcrVerificationError(`${name} must be a sha256 digest.`);
  }
  return value;
}

function requireRepository(value) {
  const normalized = value?.toLowerCase();
  if (!REPOSITORY_PATTERN.test(normalized ?? "")) {
    throw new GhcrVerificationError(
      "GHCR_REPOSITORY must contain exactly one owner/name pair.",
    );
  }
  return normalized;
}

async function fetchWithoutLeakingResponse(fetchImpl, url, init, label) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    // error-policy:J2 preserve the transport failure as the cause while
    // replacing its potentially sensitive message with verifier-owned context.
    throw new GhcrVerificationError(
      `${label} failed before receiving an HTTP response.`,
      { retryable: true, cause: error },
    );
  }
  if (!response.ok) {
    throw new GhcrVerificationError(
      `${label} returned HTTP ${response.status}.`,
      { retryable: true },
    );
  }
  return response;
}

async function parseJsonWithoutLeakingResponse(response, label) {
  try {
    return await response.json();
  } catch (error) {
    // error-policy:J2 preserve the parser failure as the cause without
    // including registry-controlled response bytes in workflow output.
    throw new GhcrVerificationError(`${label} returned invalid JSON.`, {
      retryable: true,
      cause: error,
    });
  }
}

async function verifyOnce({ repository, digest, imageId, fetchImpl }) {
  const scope = encodeURIComponent(`repository:${repository}:pull`);
  const tokenResponse = await fetchWithoutLeakingResponse(
    fetchImpl,
    `https://ghcr.io/token?scope=${scope}`,
    {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
    "Anonymous GHCR token request",
  );
  const tokenPayload = await parseJsonWithoutLeakingResponse(
    tokenResponse,
    "Anonymous GHCR token request",
  );
  const token = tokenPayload?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new GhcrVerificationError(
      "Anonymous GHCR token response did not contain a token.",
      { retryable: true },
    );
  }

  const manifestResponse = await fetchWithoutLeakingResponse(
    fetchImpl,
    `https://ghcr.io/v2/${repository}/manifests/${digest}`,
    {
      headers: {
        Accept: MANIFEST_ACCEPT,
        Authorization: `Bearer ${token}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
    "Anonymous GHCR manifest request",
  );
  const remoteDigest = manifestResponse.headers.get("docker-content-digest");
  if (remoteDigest !== digest) {
    throw new GhcrVerificationError(
      "Anonymous GHCR response returned a different manifest digest.",
    );
  }
  const manifest = await parseJsonWithoutLeakingResponse(
    manifestResponse,
    "Anonymous GHCR manifest request",
  );
  if (manifest?.config?.digest !== imageId) {
    throw new GhcrVerificationError(
      "Published manifest does not reference the boot-verified image config.",
    );
  }
}

export async function verifyAnonymousGhcrManifest({
  repository,
  digest,
  imageId,
  fetchImpl = globalThis.fetch,
  attempts = 6,
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onRetry = (message) => console.warn(message),
}) {
  const validatedRepository = requireRepository(repository);
  const validatedDigest = requireDigest("EXPECTED_DIGEST", digest);
  const validatedImageId = requireDigest("EXPECTED_IMAGE_ID", imageId);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new GhcrVerificationError(
      "attempts must be an integer from 1 to 10.",
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new GhcrVerificationError("A fetch implementation is required.");
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await verifyOnce({
        repository: validatedRepository,
        digest: validatedDigest,
        imageId: validatedImageId,
        fetchImpl,
      });
      return {
        repository: validatedRepository,
        digest: validatedDigest,
        imageId: validatedImageId,
        attempts: attempt,
      };
    } catch (error) {
      // error-policy:J1 this CI verification boundary retries only typed,
      // explicitly transient registry failures and otherwise fails closed.
      const verificationError =
        error instanceof GhcrVerificationError
          ? error
          : new GhcrVerificationError("Anonymous GHCR verification failed.", {
              cause: error,
            });
      if (!verificationError.retryable || attempt === attempts) {
        throw verificationError;
      }
      const delayMilliseconds = Math.min(2 ** (attempt - 1) * 2_000, 10_000);
      onRetry(
        `${verificationError.message} Retrying anonymous verification (${attempt + 1}/${attempts}) after ${delayMilliseconds}ms.`,
      );
      await sleep(delayMilliseconds);
    }
  }

  throw new GhcrVerificationError(
    "Anonymous GHCR verification exhausted retries.",
  );
}

async function main() {
  try {
    const inputs = parseCliArguments(process.argv.slice(2));
    const result = await verifyAnonymousGhcrManifest({
      repository: inputs.repository,
      digest: inputs.digest,
      imageId: inputs.imageId,
    });
    console.log(
      `Anonymous GHCR verification passed for ${result.repository}@${result.digest} after ${result.attempts} attempt(s).`,
    );
  } catch (error) {
    // error-policy:J1 the executable boundary emits one sanitized annotation
    // and preserves failure through the process exit code.
    const message =
      error instanceof GhcrVerificationError
        ? error.message
        : "Anonymous GHCR verification failed.";
    console.error(`::error::${message}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
