// spec/cloud/services/google/connection.md, "Story: Connect my Google account with the access I chose"
import { createHash, randomBytes } from "node:crypto";
import type { FakeAnswer, FakeHandler, FakeRequest } from "../fakes.ts";
import type { GoogleIdentityFake, GooglePerson } from "../google-identity-fake.ts";
import { issueAccess, seedGrant, type GoogleFakeState } from "./google.ts";

interface Consent {
  readonly person: GooglePerson;
  readonly scopes: ReadonlyArray<string>;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string | undefined;
}

export interface GoogleConsent {
  readonly handler: FakeHandler;
  readonly exchanges: URLSearchParams[];
  consentAs(person: GooglePerson, grant?: (asked: ReadonlyArray<string>) => ReadonlyArray<string>): void;
  denyNext(): void;
  withholdRefreshToken(): void;
  serverAuthCode(person: GooglePerson, scopes: ReadonlyArray<string>): string;
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function googleConsent(state: GoogleFakeState, identity: GoogleIdentityFake, clientSecret: string): GoogleConsent {
  const consents = new Map<string, Consent>();
  const exchanges: URLSearchParams[] = [];
  let person: GooglePerson = { subject: "google-connect-1", email: "connect@example.com", emailVerified: true };
  let grant = (asked: ReadonlyArray<string>): ReadonlyArray<string> => asked;
  let deny = false;
  let withhold = false;

  const authorize = (request: FakeRequest): FakeAnswer => {
    const query = request.query;
    const redirectUri = query.get("redirect_uri") ?? "";
    const back = (fields: Readonly<Record<string, string>>): FakeAnswer => ({ status: 302, headers: { location: `${redirectUri}?${new URLSearchParams({ ...fields, state: query.get("state") ?? "" })}` } });
    if (deny) {
      deny = false;
      return back({ error: "access_denied" });
    }
    const code = randomBytes(16).toString("base64url");
    const asked = (query.get("scope") ?? "").split(" ").filter((scope) => scope !== "");
    consents.set(code, { person, scopes: grant(asked), clientId: query.get("client_id") ?? "", redirectUri, challenge: query.get("code_challenge") ?? "" });
    return back({ code });
  };

  const token = async (form: URLSearchParams, consent: Consent): Promise<FakeAnswer> => {
    exchanges.push(form);
    if (form.get("client_secret") !== clientSecret || form.get("client_id") !== consent.clientId) return { status: 401, body: { error: "invalid_client" } };
    const bound = consent.challenge === undefined
      ? form.get("redirect_uri") === "" && !form.has("code_verifier")
      : form.get("redirect_uri") === consent.redirectUri && consent.challenge === s256(form.get("code_verifier") ?? "");
    if (!bound) return { status: 400, body: { error: "invalid_grant" } };
    const refreshToken = seedGrant(state, { subject: consent.person.subject, email: consent.person.email, scopes: consent.scopes });
    const issued = !withhold;
    withhold = false;
    return {
      status: 200,
      body: {
        access_token: issueAccess(state, refreshToken), token_type: "Bearer", expires_in: state.expiresInSeconds, scope: consent.scopes.join(" "),
        ...(issued ? { refresh_token: refreshToken } : {}),
        id_token: await identity.idToken(consent.person, { audience: consent.clientId }),
      },
    };
  };

  const handler: FakeHandler = async (request) => {
    if (request.method === "GET" && request.path === "/accounts" && request.query.get("access_type") === "offline") return authorize(request);
    if (request.method !== "POST" || request.path !== "/token") return undefined;
    const form = new URLSearchParams(request.body);
    const code = form.get("code") ?? "";
    const consent = form.get("grant_type") === "authorization_code" ? consents.get(code) : undefined;
    if (consent === undefined) return undefined;
    consents.delete(code);
    return token(form, consent);
  };

  return {
    handler,
    exchanges,
    consentAs: (next, granting) => {
      person = next;
      grant = granting ?? ((asked) => asked);
    },
    denyNext: () => { deny = true; },
    withholdRefreshToken: () => { withhold = true; },
    serverAuthCode: (who, scopes) => {
      const code = `4/${randomBytes(16).toString("base64url")}`;
      consents.set(code, { person: who, scopes, clientId: "google-server-client", redirectUri: "", challenge: undefined });
      return code;
    },
  };
}
