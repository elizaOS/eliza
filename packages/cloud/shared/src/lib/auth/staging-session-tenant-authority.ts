import { z } from "zod";
import type { ApiKey } from "../../db/repositories/api-keys";
import type { UserWithOrganization } from "../../db/repositories/users";

const fixtureProfile = z.object({
  ok: z.literal(true),
  data: z.object({
    tenantId: z.literal("elizacloud-staging"),
    userId: z.uuid(),
    tenantCustomMetadata: z.object({ elizaStagingSessionExchange: z.unknown().optional() }),
  }),
});

const fixtureGrant = z.strictObject({
  version: z.literal(1),
  grantId: z.uuid(),
  principal: z.discriminatedUnion("method", [
    z.strictObject({ method: z.literal("siwe"), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }),
    z.strictObject({ method: z.literal("email"), email: z.email() }),
  ]),
  apiKeyId: z.uuid(),
  cloudUserId: z.uuid(),
  organizationId: z.uuid(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
});

type TenantAuthority =
  | { kind: "delegated" }
  | { kind: "enrolled"; grantGeneration: string; expiresAt: number }
  | { kind: "denied"; reader: "not requested" | "denied" | "unavailable" | "verified" };

export async function resolveStagingSessionTenantAuthority(input: {
  fixtureSubject: string | undefined;
  reader: string | undefined;
  tenantId: string;
  stewardUserId: string;
  organizationTenantId: string | null;
  apiKey: Pick<ApiKey, "id" | "user_id" | "organization_id" | "user_created" | "source_app_id">;
  user: Pick<
    UserWithOrganization,
    "role" | "email" | "email_verified" | "wallet_address" | "wallet_verified" | "wallet_chain_type"
  >;
  nowSeconds: number;
}): Promise<TenantAuthority> {
  const { tenantId, stewardUserId, user, apiKey } = input;
  if (input.fixtureSubject?.trim() !== stewardUserId) {
    return input.organizationTenantId?.trim() === tenantId
      ? { kind: "delegated" }
      : { kind: "denied", reader: "not requested" };
  }
  const reader = input.reader?.trim();
  if (
    !reader ||
    tenantId !== "elizacloud-staging" ||
    !z.uuid().safeParse(stewardUserId).success ||
    user.role !== "owner" ||
    !apiKey.user_created ||
    apiKey.source_app_id !== null
  )
    return { kind: "denied", reader: "not requested" };
  try {
    const response = await fetch(
      `https://login-staging.eliza.app/platform/tenants/elizacloud-staging/users/${stewardUserId}`,
      {
        headers: { "X-Steward-Platform-Key": reader },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok)
      return {
        kind: "denied",
        reader: response.status === 401 || response.status === 403 ? "denied" : "unavailable",
      };
    const profile = fixtureProfile.safeParse(await response.json());
    if (!profile.success || profile.data.data.userId !== stewardUserId)
      return { kind: "denied", reader: "unavailable" };
    const parsed = fixtureGrant.safeParse(
      profile.data.data.tenantCustomMetadata.elizaStagingSessionExchange,
    );
    if (!parsed.success) return { kind: "denied", reader: "verified" };
    const grant = parsed.data;
    const principal = grant.principal;
    const matchesPrincipal =
      principal.method === "siwe"
        ? user.wallet_verified &&
          user.wallet_chain_type === "ethereum" &&
          user.wallet_address?.toLowerCase() === principal.address.toLowerCase()
        : user.email_verified && user.email?.trim().toLowerCase() === principal.email.toLowerCase();
    if (
      !matchesPrincipal ||
      grant.apiKeyId !== apiKey.id ||
      grant.cloudUserId !== apiKey.user_id ||
      grant.organizationId !== apiKey.organization_id ||
      grant.issuedAt > input.nowSeconds ||
      grant.expiresAt <= input.nowSeconds
    )
      return { kind: "denied", reader: "verified" };
    return {
      kind: "enrolled",
      grantGeneration: JSON.stringify([
        grant.grantId,
        grant.issuedAt,
        grant.expiresAt,
        principal.method,
        principal.method === "siwe"
          ? principal.address.toLowerCase()
          : principal.email.toLowerCase(),
      ]),
      expiresAt: grant.expiresAt,
    };
  } catch {
    // error-policy:J1 An unreachable issuer cannot establish a live tenant grant.
    return { kind: "denied", reader: "unavailable" };
  }
}
