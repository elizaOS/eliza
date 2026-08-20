/** Lists and enrolls Cloud-account-owned remote runtime hosts. */
import { Hono } from "hono";
import { z } from "zod";
import {
  generateRemoteHostToken,
  hashRemoteHostToken,
} from "@/db/crypto/remote-host-token";
import { remoteHostsRepository } from "@/db/repositories/remote-hosts";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { HeadscaleClient } from "@/lib/services/headscale-client";
import type { AppEnv } from "@/types/cloud-worker-env";

const REMOTE_HOST_TAG = "tag:eliza-remote-host";
const ENROLLMENT_TTL_MS = 15 * 60 * 1000;

const enrollmentSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  platform: z.enum(["macos", "linux", "windows"]),
  hostIdentity: z.object({
    keyId: z.string().trim().min(1).max(256),
    signingPublicKeyJwk: z.object({
      kty: z.literal("EC"),
      crv: z.literal("P-256"),
      x: z.string().min(40).max(50),
      y: z.string().min(40).max(50),
      d: z.never().optional(),
    }),
    encryptionPublicKeyJwk: z.object({
      kty: z.literal("EC"),
      crv: z.literal("P-256"),
      x: z.string().min(40).max(50),
      y: z.string().min(40).max(50),
      d: z.never().optional(),
    }),
  }),
});

function readEnv(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : null;
}

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const hosts = await remoteHostsRepository.listOwned(
      user.organization_id,
      user.id,
    );
    return c.json({
      success: true,
      data: {
        hosts: hosts.map((host) => ({
          id: host.id,
          displayName: host.display_name,
          platform: host.platform,
          connectionMode: host.connection_mode,
          hostname: host.headscale_hostname,
          runtimeKeyId: host.runtime_key_id,
          signingPublicKeyJwk: host.signing_public_jwk,
          encryptionPublicKeyJwk: host.encryption_public_jwk,
          status: host.status,
          lastSeenAt: host.last_seen_at,
          createdAt: host.created_at,
        })),
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsed = enrollmentSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "displayName and supported host platform are required",
        },
        400,
      );
    }
    const apiUrl =
      readEnv(c.env.HEADSCALE_API_URL) ?? readEnv(c.env.HEADSCALE_PUBLIC_URL);
    const publicUrl = readEnv(c.env.HEADSCALE_PUBLIC_URL) ?? apiUrl;
    const apiKey = readEnv(c.env.HEADSCALE_API_KEY);
    const userName = readEnv(c.env.HEADSCALE_USER) ?? "tunnel";
    if (!apiUrl || !publicUrl || !apiKey) {
      return c.json(
        {
          success: false,
          error: "Managed private host enrollment is unavailable",
        },
        503,
      );
    }
    const hostId = crypto.randomUUID();
    const hostname = `eliza-host-${hostId.replace(/-/g, "").slice(0, 20)}`;
    const hostToken = generateRemoteHostToken();
    const hostTokenHash = await hashRemoteHostToken(hostToken);
    const expiration = new Date(Date.now() + ENROLLMENT_TTL_MS).toISOString();
    const client = new HeadscaleClient({ apiUrl, apiKey, user: userName });
    const preAuthKey = await client.createPreAuthKey({
      reusable: false,
      ephemeral: false,
      expiration,
      aclTags: [REMOTE_HOST_TAG],
    });
    const host = await remoteHostsRepository.create({
      id: hostId,
      organization_id: user.organization_id,
      user_id: user.id,
      display_name: parsed.data.displayName,
      platform: parsed.data.platform,
      connection_mode: "managed_headscale",
      headscale_hostname: hostname,
      runtime_key_id: parsed.data.hostIdentity.keyId,
      signing_public_jwk: parsed.data.hostIdentity.signingPublicKeyJwk,
      encryption_public_jwk: parsed.data.hostIdentity.encryptionPublicKeyJwk,
      host_token_hash: hostTokenHash,
      status: "pending",
    });
    c.header("Cache-Control", "no-store");
    return c.json({
      success: true,
      data: {
        hostId: host.id,
        displayName: host.display_name,
        loginServer: publicUrl,
        authKey: preAuthKey.key,
        hostToken,
        hostname,
        expiresAt: preAuthKey.expiration || expiration,
        status: host.status,
      },
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates typed/internal failures.
    return failureResponse(c, error);
  }
});

export default app;
