/** Optional, host-scoped Headscale enrollment with compensating cleanup. */
import { HeadscaleClient } from "@/lib/services/headscale-client";

const REMOTE_HOST_TAG = "tag:eliza-remote-host";
const ENROLLMENT_TTL_MS = 15 * 60 * 1_000;

export interface ManagedNetworkConfig {
  apiUrl: string;
  publicUrl: string;
  apiKey: string;
  user: string;
}

export interface ManagedNetworkHost {
  id: string;
  headscale_hostname?: string | null;
  headscale_preauth_key_id?: string | null;
  headscale_cleanup_pending?: boolean;
}

export interface ManagedNetworkRepository {
  recordManagedEnrollment(input: {
    hostId: string;
    organizationId: string;
    userId: string;
    hostname: string;
    preAuthKeyId: string;
  }): Promise<unknown>;
  recordManagedCleanupFailure(input: {
    hostId: string;
    organizationId: string;
    userId: string;
    message: string;
  }): Promise<unknown>;
  completeManagedCleanup(input: {
    hostId: string;
    organizationId: string;
    userId: string;
  }): Promise<unknown>;
}

function readEnv(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

function validatedHeadscaleUrl(value: string, name: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
    url.hostname.toLowerCase(),
  );
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/+$/, "")
  ) {
    throw new Error(
      `${name} must be an HTTPS origin (or loopback for local QA).`,
    );
  }
  return url.origin;
}

export function managedNetworkConfig(
  env: Record<string, unknown>,
): ManagedNetworkConfig | null {
  const apiUrl = readEnv(env.HEADSCALE_API_URL);
  const publicUrl = readEnv(env.HEADSCALE_PUBLIC_URL);
  const apiKey = readEnv(env.HEADSCALE_API_KEY);
  if (!apiUrl && !publicUrl && !apiKey) return null;
  if (!apiUrl || !publicUrl || !apiKey) {
    throw new Error(
      "Managed-network enrollment requires HEADSCALE_API_URL, HEADSCALE_PUBLIC_URL, and HEADSCALE_API_KEY.",
    );
  }
  return {
    apiUrl: validatedHeadscaleUrl(apiUrl, "HEADSCALE_API_URL"),
    publicUrl: validatedHeadscaleUrl(publicUrl, "HEADSCALE_PUBLIC_URL"),
    apiKey,
    user: readEnv(env.HEADSCALE_USER) ?? "tunnel",
  };
}

function hostnameForHost(hostId: string): string {
  return `eliza-host-${hostId.replace(/-/g, "").slice(0, 20)}`;
}

function clientFor(config: ManagedNetworkConfig): HeadscaleClient {
  return new HeadscaleClient({
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
    user: config.user,
  });
}

export async function enrollManagedNetwork(input: {
  hostId: string;
  organizationId: string;
  userId: string;
  config: ManagedNetworkConfig;
  repository: ManagedNetworkRepository;
  client?: HeadscaleClient;
  now?: number;
}): Promise<{
  loginServer: string;
  authKey: string;
  hostname: string;
  expiresAt: string;
}> {
  const client = input.client ?? clientFor(input.config);
  const hostname = hostnameForHost(input.hostId);
  const expiration = new Date(
    (input.now ?? Date.now()) + ENROLLMENT_TTL_MS,
  ).toISOString();
  const preAuthKey = await client.createPreAuthKey({
    reusable: false,
    ephemeral: false,
    expiration,
    aclTags: [REMOTE_HOST_TAG],
  });
  if (!/^[1-9]\d*$/.test(preAuthKey.id)) {
    throw new Error("Headscale enrollment did not return a numeric key id.");
  }
  try {
    await input.repository.recordManagedEnrollment({
      hostId: input.hostId,
      organizationId: input.organizationId,
      userId: input.userId,
      hostname,
      preAuthKeyId: preAuthKey.id,
    });
  } catch (cause) {
    const cleanupFailures: unknown[] = [];
    try {
      await client.expirePreAuthKey(preAuthKey.id);
    } catch (cleanupCause) {
      cleanupFailures.push(cleanupCause);
    }
    try {
      await client.deletePreAuthKey(preAuthKey.id);
    } catch (cleanupCause) {
      cleanupFailures.push(cleanupCause);
    }
    if (cleanupFailures.length > 0) {
      try {
        await input.repository.recordManagedEnrollment({
          hostId: input.hostId,
          organizationId: input.organizationId,
          userId: input.userId,
          hostname,
          preAuthKeyId: preAuthKey.id,
        });
        await input.repository.recordManagedCleanupFailure({
          hostId: input.hostId,
          organizationId: input.organizationId,
          userId: input.userId,
          message: "Managed-network enrollment compensation is pending retry.",
        });
      } catch (trackingCause) {
        cleanupFailures.push(trackingCause);
      }
      throw new AggregateError(
        [cause, ...cleanupFailures],
        "Managed-network enrollment failed and compensation is pending.",
        { cause },
      );
    }
    throw cause;
  }
  return {
    loginServer: input.config.publicUrl,
    authKey: preAuthKey.key,
    hostname,
    expiresAt: preAuthKey.expiration || expiration,
  };
}

export async function cleanupManagedNetwork(input: {
  host: ManagedNetworkHost;
  organizationId: string;
  userId: string;
  config: ManagedNetworkConfig;
  repository: ManagedNetworkRepository;
  client?: HeadscaleClient;
}): Promise<void> {
  if (!input.host.headscale_cleanup_pending) return;
  const client = input.client ?? clientFor(input.config);
  const failures: unknown[] = [];
  const keyId = input.host.headscale_preauth_key_id;
  if (keyId) {
    try {
      await client.expirePreAuthKey(keyId);
    } catch (cause) {
      failures.push(cause);
    }
  }
  const hostname = input.host.headscale_hostname;
  if (hostname) {
    try {
      const node = await client.getNodeByNameStrict(hostname);
      if (node) await client.deleteNode(node.id);
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (keyId) {
    try {
      await client.deletePreAuthKey(keyId);
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length > 0) {
    await input.repository.recordManagedCleanupFailure({
      hostId: input.host.id,
      organizationId: input.organizationId,
      userId: input.userId,
      message: "Managed-network cleanup is pending retry.",
    });
    throw new AggregateError(
      failures,
      "Managed-network cleanup is pending retry.",
    );
  }
  await input.repository.completeManagedCleanup({
    hostId: input.host.id,
    organizationId: input.organizationId,
    userId: input.userId,
  });
}

export const managedNetworkInternals = {
  ENROLLMENT_TTL_MS,
  REMOTE_HOST_TAG,
  hostnameForHost,
  validatedHeadscaleUrl,
};
