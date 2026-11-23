// spec/cloud/identity/federatedSignIn.md, "Story: Sign in with Google in the browser"; spec/cloud/identity/federatedSignIn.md, "Story: Sign in with the device's Google account"
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import type { Clock } from "effect";
import { exportJWK, SignJWT } from "jose";
import type { FakeAnswer, FakeHandler, FakeRequest } from "./fakes.ts";

export interface GooglePerson {
  readonly subject: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly givenName?: string;
}

export interface IdTokenClaims {
  readonly audience: string;
  readonly nonce?: string;
  readonly issuer?: string;
  readonly expiresInSeconds?: number;
}

interface Grant {
  readonly person: GooglePerson;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly scopes: ReadonlyArray<string>;
}

interface NativeCodeOptions {
  readonly identity?: IdTokenClaims | null;
  readonly refreshToken?: boolean;
}

export interface GoogleIdentityFake {
  readonly handler: FakeHandler;
  readonly tokenRequests: URLSearchParams[];
  signInAs(person: GooglePerson): void;
  denyNext(): void;
  managedScopes(scopes: ReadonlyArray<string>): void;
  idToken(person: GooglePerson, claims: IdTokenClaims): Promise<string>;
  serverAuthCode(person: GooglePerson, scopes: ReadonlyArray<string>, options?: NativeCodeOptions): string;
}

const keyId = "google-identity-test";

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function back(redirectUri: string, fields: Readonly<Record<string, string>>): FakeAnswer {
  return { status: 302, headers: { location: `${redirectUri}?${new URLSearchParams(fields)}` } };
}

export function googleIdentityFake(clientSecret: string, clock?: Pick<Clock.Clock, "currentTimeMillisUnsafe">): GoogleIdentityFake {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = exportJWK(publicKey).then((key) => ({ ...key, kid: keyId, alg: "RS256", use: "sig" }));
  const grants = new Map<string, Grant>();
  const tokenRequests: URLSearchParams[] = [];
  const serverCodes = new Map<string, { readonly person: GooglePerson; readonly scopes: ReadonlyArray<string>; readonly options: NativeCodeOptions }>();
  const nativeAccess = new Map<string, GooglePerson>();
  let person: GooglePerson = { subject: "google-subject-1", email: "Person@Example.com", emailVerified: true, givenName: "Person" };
  let deny = false;
  let managedScopes: ReadonlyArray<string> | undefined;

  const idToken = (who: GooglePerson, claims: IdTokenClaims) => {
    const issuedAt = Math.floor((clock?.currentTimeMillisUnsafe() ?? Date.now()) / 1000);
    return new SignJWT({ email: who.email, email_verified: who.emailVerified, ...(who.givenName === undefined ? {} : { given_name: who.givenName }), ...(claims.nonce === undefined ? {} : { nonce: claims.nonce }) })
      .setProtectedHeader({ alg: "RS256", kid: keyId })
      .setIssuer(claims.issuer ?? "https://accounts.google.com")
      .setAudience(claims.audience)
      .setSubject(who.subject)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + (claims.expiresInSeconds ?? 300))
      .sign(privateKey);
  };

  const accounts = (request: FakeRequest): FakeAnswer => {
    const query = request.query;
    const redirectUri = query.get("redirect_uri") ?? "";
    const state = query.get("state") ?? "";
    if (deny) {
      deny = false;
      return back(redirectUri, { error: "access_denied", state });
    }
    const code = randomBytes(16).toString("base64url");
    const scopes = managedScopes ?? (query.get("scope") ?? "").split(/\s+/).filter(Boolean);
    grants.set(code, { person, clientId: query.get("client_id") ?? "", redirectUri, challenge: query.get("code_challenge") ?? "", scopes });
    return back(redirectUri, { code, state });
  };

  const token = async (request: FakeRequest): Promise<FakeAnswer> => {
    const form = new URLSearchParams(request.body);
    tokenRequests.push(form);
    const grant = grants.get(form.get("code") ?? "");
    grants.delete(form.get("code") ?? "");
    if (form.get("client_secret") !== clientSecret) return { status: 401, body: { error: "invalid_client" } };
    const server = serverCodes.get(form.get("code") ?? "");
    serverCodes.delete(form.get("code") ?? "");
    if (server !== undefined) {
      if (form.get("client_id") !== "google-server-client" || form.get("redirect_uri") !== "" || form.has("code_verifier")) return { status: 400, body: { error: "invalid_grant" } };
      const access = `access-${server.person.subject}`;
      nativeAccess.set(access, server.person);
      const { identity, refreshToken } = server.options;
      return {
        status: 200,
        body: {
          access_token: access, token_type: "Bearer", expires_in: 3600,
          ...(refreshToken === false ? {} : { refresh_token: `refresh-${server.person.subject}` }),
          scope: server.scopes.join(" "),
          ...(identity === null ? {} : { id_token: await idToken(server.person, identity ?? { audience: "google-server-client" }) }),
        },
      };
    }
    if (grant === undefined || grant.clientId !== form.get("client_id") || grant.redirectUri !== form.get("redirect_uri") || grant.challenge !== s256(form.get("code_verifier") ?? "")) {
      return { status: 400, body: { error: "invalid_grant" } };
    }
    const access = grant.redirectUri.endsWith("/api/v1/oauth/google/callback") ? `access-${grant.person.subject}` : "unused";
    return { status: 200, body: {
      access_token: access, token_type: "Bearer", expires_in: 3600, id_token: await idToken(grant.person, { audience: grant.clientId }),
      ...(access === "unused" ? {} : { refresh_token: `refresh-${grant.person.subject}`, scope: grant.scopes.join(" ") }),
    } };
  };

  const handler: FakeHandler = async (request) => {
    if (request.method === "GET" && request.path === "/accounts") return accounts(request);
    if (request.method === "GET" && request.path === "/jwks") return { status: 200, body: { keys: [await jwk] } };
    if (request.method === "GET" && request.path === "/api/oauth2/v2/userinfo") {
      const bearer = typeof request.headers.authorization === "string" ? /^Bearer (.+)$/.exec(request.headers.authorization) : null;
      const user = bearer === null ? undefined : nativeAccess.get(bearer[1] ?? "");
      if (user === undefined) return { status: 401, body: { error: "invalid_token" } };
      return { status: 200, body: { id: user.subject, email: user.email, verified_email: user.emailVerified, name: user.givenName } };
    }
    if (request.method === "POST" && request.path === "/token" && new URLSearchParams(request.body).get("grant_type") === "authorization_code") return token(request);
    return undefined;
  };

  return {
    handler,
    tokenRequests,
    signInAs: (next) => { person = next; },
    denyNext: () => { deny = true; },
    managedScopes: (scopes) => { managedScopes = [...scopes]; },
    idToken,
    serverAuthCode: (who, scopes, options = {}) => {
      const code = `4/${randomBytes(16).toString("base64url")}`;
      serverCodes.set(code, { person: who, scopes, options });
      return code;
    },
  };
}

export interface Redirect {
  readonly status: number;
  readonly location: string;
  readonly body: string;
}

/** @throws {TypeError} */
export async function visit(url: string): Promise<Redirect> {
  const response = await fetch(url, { redirect: "manual" });
  return { status: response.status, location: response.headers.get("location") ?? "", body: await response.text() };
}

/** @throws {never} */
export function fragment(location: string): URLSearchParams {
  return new URLSearchParams(location.slice(location.indexOf("#") + 1));
}
