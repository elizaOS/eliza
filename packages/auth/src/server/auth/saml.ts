import {
  type CacheItem,
  type CacheProvider,
  SAML,
  ValidateInResponseTo,
} from "@node-saml/node-saml";

export interface VerifySamlAcsInput {
  samlResponse: string;
  expectedRequestId?: string;
  tenantId: string;
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertPems: string[];
  spEntityId: string;
  acsUrl: string;
  emailAttribute?: string;
  groupsAttribute?: string;
  acceptedClockSkewMs?: number;
}

export interface VerifiedSamlAssertion {
  tenantId: string;
  issuer: string;
  assertionId: string;
  nameId: string;
  email: string;
  groups: string[];
  sessionIndex?: string;
  attributes: Record<string, unknown>;
}

export interface BuildSamlAuthorizeUrlInput {
  relayState: string;
  requestId: string;
  idpSsoUrl: string;
  idpEntityId: string;
  idpCertPems: string[];
  spEntityId: string;
  acsUrl: string;
}

export interface BuiltSamlAuthorizeUrl {
  url: string;
  requestId: string;
}

/**
 * ExpectedRequestIdEchoCache — a CacheProvider that ECHOES the expected
 * SAML request ID so node-saml's InResponseTo comparison can run against a
 * caller-verified request id.
 *
 * Deliberately NOT a single-use replay cache (despite node-saml's cache
 * provider shape): getAsync returns the expected id on every call and
 * removeAsync is a no-op. Actual replay protection lives in the API layer —
 * the atomic consumeSamlAuthnRequest + the tenantSamlAssertionReplays unique
 * index — which consumes the authn request before this verifier runs and
 * rejects duplicate assertion ids at insert time. When no expectedRequestId
 * is supplied, getAsync returns null and node-saml treats InResponseTo as
 * "never validate" — IdP-initiated SSO responses carry none by design.
 */
class ExpectedRequestIdEchoCache implements CacheProvider {
  constructor(private readonly expectedRequestId?: string) {}

  async saveAsync(key: string, value: string): Promise<CacheItem> {
    return { value: value || key, createdAt: Date.now() };
  }

  async getAsync(key: string): Promise<string | null> {
    if (!this.expectedRequestId) return null;
    return key === this.expectedRequestId ? this.expectedRequestId : null;
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (!key || !this.expectedRequestId) return null;
    return key === this.expectedRequestId ? this.expectedRequestId : null;
  }
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value))
    return value.find((item): item is string => typeof item === "string");
  return undefined;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string =>
      typeof item === "string" && item.trim().length > 0,
  );
}

function profileAttributes(
  profile: Record<string, unknown>,
): Record<string, unknown> {
  const blocked = new Set([
    "issuer",
    "sessionIndex",
    "nameID",
    "nameIDFormat",
    "nameQualifier",
    "spNameQualifier",
    "ID",
    "getAssertionXml",
    "getAssertion",
    "getSamlResponseXml",
  ]);
  return Object.fromEntries(
    Object.entries(profile).filter(([key]) => !blocked.has(key)),
  );
}

export async function verifySamlAcsResponse(
  input: VerifySamlAcsInput,
): Promise<VerifiedSamlAssertion> {
  if (!input.samlResponse || input.samlResponse.length > 262_144) {
    throw new Error("SAMLResponse is required and must be under 256 KiB");
  }
  if (input.idpCertPems.length === 0) {
    throw new Error("At least one IdP certificate is required");
  }

  const saml = new SAML({
    entryPoint: input.idpSsoUrl,
    idpIssuer: input.idpEntityId,
    idpCert: input.idpCertPems,
    issuer: input.spEntityId,
    audience: input.spEntityId,
    callbackUrl: input.acsUrl,
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: true,
    acceptedClockSkewMs: input.acceptedClockSkewMs ?? 120_000,
    maxAssertionAgeMs: 5 * 60_000,
    validateInResponseTo: input.expectedRequestId
      ? ValidateInResponseTo.always
      : ValidateInResponseTo.never,
    cacheProvider: new ExpectedRequestIdEchoCache(input.expectedRequestId),
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
    disableRequestedAuthnContext: true,
  });

  const result = await saml.validatePostResponseAsync({
    SAMLResponse: input.samlResponse,
  });
  if (result.loggedOut || !result.profile) {
    throw new Error("SAMLResponse did not contain a login assertion");
  }

  const profile = result.profile as Record<string, unknown>;
  const assertionId = firstString(profile.ID);
  if (!assertionId)
    throw new Error("SAML assertion ID is required for replay protection");

  const emailAttribute = input.emailAttribute || "email";
  const email = firstString(profile[emailAttribute]);
  if (!email)
    throw new Error(
      "SAML assertion did not include a verified email attribute",
    );

  return {
    tenantId: input.tenantId,
    issuer: String(profile.issuer ?? ""),
    assertionId,
    nameId: String(profile.nameID ?? ""),
    email,
    groups: stringList(
      input.groupsAttribute ? profile[input.groupsAttribute] : undefined,
    ),
    sessionIndex: firstString(profile.sessionIndex),
    attributes: profileAttributes(profile),
  };
}

export async function buildSamlAuthorizeUrl(
  input: BuildSamlAuthorizeUrlInput,
): Promise<BuiltSamlAuthorizeUrl> {
  const saml = new SAML({
    entryPoint: input.idpSsoUrl,
    idpIssuer: input.idpEntityId,
    idpCert: input.idpCertPems,
    issuer: input.spEntityId,
    audience: input.spEntityId,
    callbackUrl: input.acsUrl,
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: true,
    validateInResponseTo: ValidateInResponseTo.always,
    cacheProvider: new ExpectedRequestIdEchoCache(input.requestId),
    generateUniqueId: () => input.requestId,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
    disableRequestedAuthnContext: true,
  });

  return {
    requestId: input.requestId,
    url: await saml.getAuthorizeUrlAsync(input.relayState, undefined, {}),
  };
}
