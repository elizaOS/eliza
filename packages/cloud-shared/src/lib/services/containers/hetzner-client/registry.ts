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
    throw new HetznerClientError(
      "invalid_input",
      `Failed to read Docker registry token file '${tokenFile.split("/").pop() ?? "unknown"}': ${error instanceof Error ? error.message : String(error)}`,
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

export async function readPulledImageDigest(
  ssh: DockerSSHClient,
  image: string,
): Promise<string | undefined> {
  const output = await ssh
    .exec(`docker image inspect --format '{{json .RepoDigests}}' ${shellQuote(image)}`, 30_000)
    .catch(() => "");
  const trimmed = output.trim();
  if (!trimmed || trimmed === "null") return undefined;
  try {
    const repoDigests = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(repoDigests)) return undefined;
    return repoDigests.find((value): value is string => {
      return typeof value === "string" && value.includes("@sha256:");
    });
  } catch {
    return undefined;
  }
}
