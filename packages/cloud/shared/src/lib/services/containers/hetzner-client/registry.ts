/**
 * Image registry helpers — login + post-pull digest read.
 *
 * Encapsulates the credential/token resolution and the `docker login`
 * + `docker image inspect` shell incantations so the createContainer
 * flow can stay focused on lifecycle.
 */

import * as fs from "fs";
import { containersEnv } from "../../../config/containers-env";
import { logger } from "../../../utils/logger";
import { shellQuote } from "../../docker-sandbox-utils";
import type { DockerSSHClient } from "../../docker-ssh";
import { HetznerClientError } from "./types";

export function getImageRegistryHost(image: string): string | null {
  const firstSegment = image.split("/")[0];
  if (!firstSegment) return null;
  if (firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost") {
    return firstSegment;
  }
  return null;
}

function readRegistryToken(): string | undefined {
  const envToken = containersEnv.registryToken();
  if (envToken) return envToken;

  const tokenFile = containersEnv.registryTokenFile();
  if (!tokenFile) return undefined;

  try {
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    return token || undefined;
  } catch (error) {
    // error-policy:J2 translate a configured-but-unreadable token file into a
    // typed invalid_input failure (with cause) so a misconfigured registry
    // credential surfaces to the route layer instead of silently falling back
    // to an anonymous pull that would 401 on a private image.
    throw new HetznerClientError(
      "invalid_input",
      `Failed to read Docker registry token file '${tokenFile.split("/").pop() ?? "unknown"}': ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
}

export async function loginToImageRegistry(ssh: DockerSSHClient, image: string): Promise<void> {
  const registryHost = getImageRegistryHost(image);
  if (!registryHost) return;

  const username = containersEnv.registryUsername();
  const token = readRegistryToken();
  // When credentials are not configured, skip login and let `docker pull`
  // negotiate an anonymous token (GHCR and Docker Hub both support this for
  // public images). Requiring login for every ghcr.io ref blocked deploys of
  // first-party public images like ghcr.io/elizaos/eliza:stable.
  if (!username || !token) {
    logger.warn(
      `[loginToImageRegistry] No registry credentials configured for ${registryHost}; relying on anonymous pull (public images only — a private image will fail at docker pull)`,
    );
    return;
  }

  await ssh.exec(
    `printf %s ${shellQuote(token)} | docker login ${shellQuote(registryHost)} -u ${shellQuote(username)} --password-stdin >/dev/null`,
    60_000,
  );
}

/**
 * Guarantee deterministic registry access on a node before pulling `image`.
 *
 * The managed agent image (`ghcr.io/elizaos/eliza`) is public, so an anonymous
 * pull works with no credentials. But a node that ever ran `docker login` with
 * a token that has since expired/rotated keeps a stale entry in
 * `~/.docker/config.json` which OVERRIDES anonymous access — the pull then fails
 * with `denied` even though the image is public. This is the failure class that
 * bricks Hetzner robot hosts whose creds rotated out from under them.
 *
 * Two idempotent, best-effort branches:
 *   - registry token configured → `loginToImageRegistry` writes a fresh cred.
 *   - no token configured       → `docker logout <registryHost>` clears any
 *     stale cred so the pull falls back to deterministic anonymous access.
 *
 * Never hard-fails: a logout/login hiccup must not block the pull that follows.
 */
export async function ensureRegistryAccess(ssh: DockerSSHClient, image: string): Promise<void> {
  const registryHost = getImageRegistryHost(image);
  if (!registryHost) return;

  if (containersEnv.registryToken() || containersEnv.registryTokenFile()) {
    // error-policy:J6 best-effort registry priming — a login hiccup must not
    // block the `docker pull` that follows (which is the real gate and will
    // fail loudly if the cred was actually required). Surfaced via warn.
    await loginToImageRegistry(ssh, image).catch((error) => {
      logger.warn(`[ensureRegistryAccess] docker login to ${registryHost} failed; continuing`, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }

  // No token configured: proactively drop any stale stored credential so the
  // public-image pull uses anonymous access deterministically.
  // error-policy:J6 best-effort stale-cred clearing — a logout hiccup must not
  // block the anonymous pull that follows; the pull is the real gate.
  await ssh
    .exec(`docker logout ${shellQuote(registryHost)} >/dev/null 2>&1 || true`, 30_000)
    .catch((error) => {
      logger.warn(
        `[ensureRegistryAccess] docker logout ${registryHost} failed; a stale cred may block the public pull`,
        { error: error instanceof Error ? error.message : String(error) },
      );
    });
}

/**
 * Read the repo digest Docker resolved for `image` after a successful pull.
 *
 * Best-effort informational metadata: the digest is captured post-pull and
 * stored for later blue/green digest-mismatch checks (see `eliza-sandbox`). The
 * container is already pulled and about to start, so a failed inspect must not
 * abort provisioning — but it must not read as "no digest" *silently* either.
 * A transport/SSH failure and an unparseable payload are both surfaced via
 * `logger.warn`, keeping them distinguishable from the designed-empty case (an
 * image that genuinely has no `RepoDigests`), which returns `undefined` quietly.
 */
export async function readPulledImageDigest(
  ssh: DockerSSHClient,
  image: string,
): Promise<string | undefined> {
  let output: string;
  try {
    output = await ssh.exec(
      `docker image inspect --format '{{json .RepoDigests}}' ${shellQuote(image)}`,
      30_000,
    );
  } catch (error) {
    // error-policy:J6 best-effort post-pull metadata read; surface the transport
    // failure rather than conflating it with an image that has no digest.
    logger.warn(
      `[readPulledImageDigest] docker image inspect failed for ${image}; digest unknown`,
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return undefined;
  }

  const trimmed = output.trim();
  if (!trimmed || trimmed === "null") return undefined;

  try {
    const repoDigests = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(repoDigests)) return undefined;
    return repoDigests.find((value): value is string => {
      return typeof value === "string" && value.includes("@sha256:");
    });
  } catch (error) {
    // error-policy:J3 untrusted docker output — a non-JSON RepoDigests payload
    // is malformed, not a fatal provisioning failure; surface it and treat the
    // digest as absent.
    logger.warn(`[readPulledImageDigest] unparseable RepoDigests output for ${image}`, {
      output: trimmed,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
