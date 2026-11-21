// spec/cloud/services/google/connection.md, "Story: Connect my Google account with the access I chose"
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import type { FakeAnswer, FakeHandler, FakeRequest } from "../fakes.ts";

export interface FakeGrant {
  readonly refreshToken: string;
  readonly subject: string;
  readonly email: string;
  readonly beforeUserinfoResponse?: () => Promise<void>;
  scopes: string[];
}

export interface FakeAccess {
  readonly refreshToken: string;
  readonly expiresAt: number;
}

export interface FakePart {
  readonly partId: string;
  readonly mimeType: string;
  readonly filename?: string;
  readonly text?: string;
  readonly attachmentId?: string;
  readonly data?: string;
}

export interface FakeMessage {
  readonly id: string;
  threadId: string;
  historyId: string;
  labelIds: string[];
  readonly internalDate: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly snippet: string;
  readonly parts: FakePart[];
  raw?: string;
}

export interface FakeLabel {
  readonly id: string;
  readonly name: string;
  readonly type: "system" | "user";
}

export interface FakeDraft {
  readonly id: string;
  messageId: string;
  raw: string;
}

export interface FakeCalendar {
  readonly id: string;
  readonly summary: string;
  readonly accessRole: "owner" | "writer" | "reader" | "freeBusyReader";
  readonly primary?: boolean;
  readonly timeZone: string;
}

export interface FakeEvent {
  readonly id: string;
  readonly calendarId: string;
  etag: string;
  body: Record<string, unknown>;
}

export interface FakeSwitches {
  dropNextReply: boolean;
  failNext: FakeAnswer | undefined;
}

export interface GoogleFakeState {
  readonly grants: Map<string, FakeGrant>;
  readonly access: Map<string, FakeAccess>;
  readonly revoked: Set<string>;
  readonly codes: Map<string, string>;
  readonly messages: Map<string, FakeMessage>;
  readonly labels: Map<string, FakeLabel>;
  readonly drafts: Map<string, FakeDraft>;
  readonly calendars: Map<string, FakeCalendar>;
  readonly events: Map<string, FakeEvent>;
  readonly switches: FakeSwitches;
  readonly calls: Array<{ readonly method: string; readonly path: string }>;
  history: number;
  issued: number;
  tokenCalls: number;
  tokenDelayMs: number;
  expiresInSeconds: number;
}

const systemLabels = ["INBOX", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "TRASH", "SPAM"];

export function googleFakeState(): GoogleFakeState {
  return {
    grants: new Map(),
    access: new Map(),
    revoked: new Set(),
    codes: new Map(),
    messages: new Map(),
    labels: new Map(systemLabels.map((id) => [id, { id, name: id, type: "system" }])),
    drafts: new Map(),
    calendars: new Map(),
    events: new Map(),
    switches: { dropNextReply: false, failNext: undefined },
    calls: [],
    history: 1000,
    issued: 0,
    tokenCalls: 0,
    tokenDelayMs: 0,
    expiresInSeconds: 3600,
  };
}

export function nextHistory(state: GoogleFakeState): string {
  state.history += 1;
  return String(state.history);
}

export function seedGrant(state: GoogleFakeState, grant: Omit<FakeGrant, "refreshToken" | "scopes"> & { readonly scopes: ReadonlyArray<string> }): string {
  state.issued += 1;
  const refreshToken = `refresh-${state.issued}-${grant.subject}`;
  state.grants.set(refreshToken, { ...grant, refreshToken, scopes: [...grant.scopes] });
  return refreshToken;
}

export function seedCode(state: GoogleFakeState, grant: Parameters<typeof seedGrant>[1]): string {
  const refreshToken = seedGrant(state, grant);
  const code = `4/0Afake-server-code-${state.issued}`;
  state.codes.set(code, refreshToken);
  return code;
}

export function issueAccess(state: GoogleFakeState, refreshToken: string): string {
  state.issued += 1;
  const accessToken = `access-${state.issued}`;
  state.access.set(accessToken, { refreshToken, expiresAt: Date.now() + state.expiresInSeconds * 1000 });
  return accessToken;
}

export function bearerGrant(state: GoogleFakeState, request: FakeRequest): FakeGrant | undefined {
  const token = /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ""))?.[1];
  const access = token === undefined ? undefined : state.access.get(token);
  if (access === undefined || access.expiresAt <= Date.now() || state.revoked.has(access.refreshToken)) return undefined;
  return state.grants.get(access.refreshToken);
}

export const unauthenticated: FakeAnswer = { status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED" } } };

export async function switched(state: GoogleFakeState, request: FakeRequest, handle: () => FakeAnswer | undefined): Promise<FakeAnswer | undefined> {
  const failure = state.switches.failNext;
  if (failure !== undefined) {
    state.switches.failNext = undefined;
    state.calls.push({ method: request.method, path: request.path });
    return failure;
  }
  const answer = handle();
  if (answer === undefined) return undefined;
  state.calls.push({ method: request.method, path: request.path });
  if (!state.switches.dropNextReply) return answer;
  state.switches.dropNextReply = false;
  return { status: 504, body: { error: { code: 504, status: "DEADLINE_EXCEEDED" } } };
}

function form(request: FakeRequest): URLSearchParams {
  return new URLSearchParams(request.body);
}

function refreshGrant(state: GoogleFakeState, request: FakeRequest): FakeAnswer {
  const body = form(request);
  const refreshToken = body.get("refresh_token") ?? "";
  const grant = state.grants.get(refreshToken);
  if (!body.get("client_id") || !body.get("client_secret")) return { status: 401, body: { error: "invalid_client" } };
  if (grant === undefined || state.revoked.has(refreshToken)) return { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } };
  return {
    status: 200,
    body: { access_token: issueAccess(state, refreshToken), expires_in: state.expiresInSeconds, scope: grant.scopes.join(" "), token_type: "Bearer" },
  };
}

function redeemCode(state: GoogleFakeState, request: FakeRequest): FakeAnswer {
  const body = form(request);
  const refreshToken = state.codes.get(body.get("code") ?? "");
  if (!body.get("client_id") || !body.get("client_secret")) return { status: 401, body: { error: "invalid_client" } };
  if (refreshToken === undefined || body.get("redirect_uri") !== "") return { status: 400, body: { error: "invalid_grant" } };
  state.codes.delete(body.get("code") ?? "");
  const grant = state.grants.get(refreshToken);
  return {
    status: 200,
    body: { access_token: issueAccess(state, refreshToken), refresh_token: refreshToken, expires_in: state.expiresInSeconds, scope: grant?.scopes.join(" "), token_type: "Bearer" },
  };
}

function userinfo(state: GoogleFakeState, request: FakeRequest): FakeAnswer {
  const grant = bearerGrant(state, request);
  return grant === undefined ? unauthenticated : { status: 200, body: { sub: grant.subject, email: grant.email, email_verified: true } };
}

function revoke(state: GoogleFakeState, request: FakeRequest): FakeAnswer {
  const token = form(request).get("token") ?? "";
  const refreshToken = state.grants.has(token) ? token : state.access.get(token)?.refreshToken;
  if (refreshToken === undefined || state.revoked.has(refreshToken)) return { status: 400, body: { error: "invalid_token" } };
  state.revoked.add(refreshToken);
  return { status: 200, body: {} };
}

export function mountGoogleToken(state: GoogleFakeState): FakeHandler {
  return async (request) => {
    if (request.method === "GET" && request.path === "/v1/userinfo") {
      await bearerGrant(state, request)?.beforeUserinfoResponse?.();
      return switched(state, request, () => userinfo(state, request));
    }
    if (request.method !== "POST") return undefined;
    if (request.path === "/token" && form(request).get("grant_type") === "authorization_code") return switched(state, request, () => redeemCode(state, request));
    if (request.path === "/token" && form(request).get("grant_type") === "refresh_token") {
      state.tokenCalls += 1;
      if (state.tokenDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.tokenDelayMs));
      return switched(state, request, () => refreshGrant(state, request));
    }
    if (request.path === "/revoke") return switched(state, request, () => revoke(state, request));
    return undefined;
  };
}

const googleHosts = new Set(["oauth2.googleapis.com", "openidconnect.googleapis.com"]);

export function interceptGoogle(state: GoogleFakeState): () => void {
  const handler = mountGoogleToken(state);
  const network = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!googleHosts.has(url.hostname)) return network(input, init);
    const request = new Request(input, init);
    const raw = new Uint8Array(await request.arrayBuffer());
    const answer = await handler({
      method: request.method, path: url.pathname, query: url.searchParams, headers: Object.fromEntries(request.headers), body: new TextDecoder().decode(raw), raw,
    });
    return answer === undefined ? new Response(null, { status: 404 }) : Response.json(answer.body ?? {}, { status: answer.status });
  };
  return () => { globalThis.fetch = network; };
}

export interface NativeIdTokens {
  readonly keys: JWTVerifyGetKey;
  issue(subject: string, nonce: string): Promise<string>;
}

export async function nativeIdTokens(audience: string): Promise<NativeIdTokens> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "native-google", alg: "RS256" }] });
  return {
    keys,
    issue: (subject, nonce) => new SignJWT({ nonce, email: subject + "@gmail.com", email_verified: true })
      .setProtectedHeader({ alg: "RS256", kid: "native-google" }).setIssuer("https://accounts.google.com").setAudience(audience)
      .setSubject(subject).setIssuedAt().setExpirationTime("5m").sign(privateKey),
  };
}
