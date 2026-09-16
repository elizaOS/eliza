/** Issues registration-bound Outreachr grants without exposing Cloud or Google credentials. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ElizaError } from "@elizaos/core";

const GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class OutreachrDelegationError extends ElizaError {
  override readonly name = "OutreachrDelegationError";
  constructor(
    readonly status: 401 | 403 | 503,
    code: string,
    message: string,
  ) {
    super(message, { code, severity: "fatal" });
  }
}

export interface OutreachrRegistration {
  appId: string;
  clientSecretSha256: string;
  origin: string;
}

export interface OutreachrPrincipal {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

export interface OutreachrGrant {
  authorizationCodeDigest: string;
  appId: string;
  userId: string;
  organizationId: string;
  registrationDigest: string;
  expiresAt: number;
}

export interface OutreachrDelegationDependencies {
  verifyRegistration(registration: OutreachrRegistration): Promise<void>;
  consumeCode(code: string): Promise<{ appId: string; userId: string } | null>;
  findPrincipal(userId: string): Promise<OutreachrPrincipal | null>;
  saveGrant(key: string, record: OutreachrGrant, ttlMs: number): Promise<boolean>;
  readGrant(key: string): Promise<OutreachrGrant | null>;
  deleteGrant(key: string): Promise<boolean>;
  now(): number;
}

export function outreachrRegistration(env: {
  OUTREACHR_APP_ID?: string;
  OUTREACHR_CLIENT_SECRET_SHA256?: string;
  OUTREACHR_ORIGIN?: string;
}): OutreachrRegistration {
  const appId = env.OUTREACHR_APP_ID ?? "";
  const clientSecretSha256 = env.OUTREACHR_CLIENT_SECRET_SHA256 ?? "";
  const origin = env.OUTREACHR_ORIGIN ?? "";
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(appId) ||
    !/^[a-f0-9]{64}$/.test(clientSecretSha256)
  ) {
    throw new OutreachrDelegationError(
      503,
      "OUTREACHR_NOT_CONFIGURED",
      "Outreachr integration is not configured",
    );
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // error-policy:J1 translate malformed operator configuration into a closed product boundary.
    throw new OutreachrDelegationError(
      503,
      "OUTREACHR_ORIGIN_INVALID",
      "Outreachr origin is not configured correctly",
    );
  }
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) {
    throw new OutreachrDelegationError(
      503,
      "OUTREACHR_ORIGIN_INVALID",
      "Outreachr requires an exact HTTPS origin",
    );
  }
  return { appId, clientSecretSha256, origin };
}

function grantKey(token: string): string {
  return `outreachr:delegation:${digest(token)}`;
}

export class OutreachrDelegationService {
  constructor(private readonly deps: OutreachrDelegationDependencies) {}

  async requireClient(registration: OutreachrRegistration, secret: string): Promise<void> {
    const actual = Buffer.from(digest(secret));
    const expected = Buffer.from(registration.clientSecretSha256);
    if (
      secret.length < 32 ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new OutreachrDelegationError(
        401,
        "OUTREACHR_CLIENT_INVALID",
        "Invalid Outreachr client credentials",
      );
    }
    await this.deps.verifyRegistration(registration);
  }

  private async requirePrincipal(userId: string): Promise<OutreachrPrincipal> {
    const user = await this.deps.findPrincipal(userId);
    if (!user || !user.organizationId || !user.email || !user.emailVerified) {
      throw new OutreachrDelegationError(
        403,
        "OUTREACHR_IDENTITY_UNAVAILABLE",
        "An active Eliza account with a verified email is required",
      );
    }
    return user;
  }

  async exchange(registration: OutreachrRegistration, secret: string, code: string) {
    await this.requireClient(registration, secret);
    const authorization = await this.deps.consumeCode(code);
    if (!authorization || authorization.appId !== registration.appId) {
      throw new OutreachrDelegationError(
        401,
        "OUTREACHR_CODE_INVALID",
        "Invalid, expired, or wrong-application authorization code",
      );
    }
    const user = await this.requirePrincipal(authorization.userId);
    const token = `outreachr_${randomBytes(32).toString("base64url")}`;
    const expiresAt = this.deps.now() + GRANT_TTL_MS;
    const stored = await this.deps.saveGrant(
      grantKey(token),
      {
        authorizationCodeDigest: digest(code),
        appId: registration.appId,
        userId: user.id,
        organizationId: user.organizationId,
        registrationDigest: registration.clientSecretSha256,
        expiresAt,
      },
      GRANT_TTL_MS,
    );
    if (!stored)
      throw new OutreachrDelegationError(
        503,
        "OUTREACHR_GRANT_UNAVAILABLE",
        "Unable to persist the delegated session",
      );
    return { token, expiresAt: new Date(expiresAt).toISOString(), user };
  }

  async authorize(
    registration: OutreachrRegistration,
    secret: string,
    token: string,
  ): Promise<OutreachrPrincipal> {
    await this.requireClient(registration, secret);
    if (!/^outreachr_[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new OutreachrDelegationError(
        401,
        "OUTREACHR_GRANT_INVALID",
        "Invalid delegated session",
      );
    }
    const grant = await this.deps.readGrant(grantKey(token));
    if (
      !grant ||
      grant.appId !== registration.appId ||
      grant.registrationDigest !== registration.clientSecretSha256 ||
      grant.expiresAt <= this.deps.now()
    ) {
      throw new OutreachrDelegationError(
        401,
        "OUTREACHR_GRANT_EXPIRED",
        "Delegated session has expired or was revoked",
      );
    }
    const user = await this.requirePrincipal(grant.userId);
    if (user.organizationId !== grant.organizationId) {
      throw new OutreachrDelegationError(
        401,
        "OUTREACHR_PRINCIPAL_CHANGED",
        "Eliza account membership changed; sign in again",
      );
    }
    return user;
  }

  async revoke(registration: OutreachrRegistration, secret: string, token: string): Promise<void> {
    await this.requireClient(registration, secret);
    if (!/^outreachr_[A-Za-z0-9_-]{43}$/.test(token)) return;
    if (!(await this.deps.deleteGrant(grantKey(token)))) {
      throw new OutreachrDelegationError(
        503,
        "OUTREACHR_REVOCATION_UNCONFIRMED",
        "Session revocation could not be confirmed",
      );
    }
  }
}
