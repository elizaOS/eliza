// spec/cloud/nativeClients/deviceKeys.md, "Story: Sign a device in and keep its key"; spec/cloud/nativeClients/deviceKeys.md, "Story: Sign a device out"; spec/cloud/nativeClients/deviceKeys.md, "Story: Keep no grant longer than it can be used"
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Cause, Clock, ConfigProvider, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Driver, Options } from "../../gen/cloud__nativeClients__deviceKeys.conformance.ts";
import type { CodeRequest, Event, Grant, GrantPhase } from "../../gen/cloud__nativeClients__deviceKeys.ts";
import type { ClientCheck } from "../../gen/cloud__nativeClients__registry.ts";
import type { CredentialView } from "../../gen/cloud__identity__sessions.ts";
import type { CloudContext } from "../../src/http/routes.vibe";
import { area as identity } from "../../src/http/routes/identity.vibe";
import { area as nativeClients } from "../../src/http/routes/native-clients.vibe";
import { respond } from "../../src/http/transport.vibe";
import { landAccount } from "../../src/identity/accounts.vibe";
import { issueSession, revokeAllSessions } from "../../src/identity/sessions.vibe";
import { grants, revokeAll, sweepGrants } from "../../src/native-clients/device-keys.vibe";
import { decodeRegistration, disableClient, readClient, registerClient, updateClient } from "../../src/native-clients/registry.vibe";
import { deploymentLayer, parseProfile, type CloudProfile, type Deployment } from "../../src/profile/profile.vibe";
import { Store, type Row, type Tx } from "../../src/store/connection.vibe";
import { loadRow } from "../../src/store/rows.vibe";
import { migrate, storeLayer } from "../../src/store/store.vibe";
import { authenticatorCode } from "../support/authenticator.ts";
import { manualClock } from "../support/clock.ts";
import { startFakeServer, type FakeServer } from "../support/fakes.ts";
import { googleIdentityFake, type GoogleIdentityFake, type GooglePerson } from "../support/google-identity-fake.ts";
import { secrets, testDatabaseIdentity, testProfile } from "../support/profile.ts";

type Seen = Pick<Grant, "phase" | "origin" | "codeExpiresAt" | "credentialTtl"> & { readonly credentialIssued: boolean };

interface Person {
  readonly userId: string;
  readonly organizationId: string;
  readonly google: GooglePerson;
  readonly marks: number[];
  factor: boolean;
}

interface Device {
  readonly grantKey: string;
  readonly code: string;
  readonly state: string;
  readonly verifier: string;
  minted?: { readonly credentialId: string; readonly secret: string };
}

interface Answered {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

interface Target {
  readonly clientId: string;
  readonly redirectUri: string;
}

interface Cloud {
  readonly runtime: ManagedRuntime.ManagedRuntime<CloudContext, unknown>;
  readonly googleOff: Layer.Layer<Deployment>;
  readonly fakes: FakeServer;
  readonly google: GoogleIdentityFake;
}

const web = "https://www.staging.example.com";
const serverClientId = "google-server-client";
const time = manualClock();
const devices = new Map<string, Device>();
const people = new Map<string, Person>();
const registered = new Map<string, { readonly credentialTtl: number; readonly nativeGoogle: boolean }>();
const routes = [identity, nativeClients].flatMap((area) => area.routes);
let now = 0;
let addresses = 0;
let accessLifetime: number | undefined;
let cloud: Promise<Cloud> | undefined;

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const s256 = (verifier: string) => createHash("sha256").update(verifier, "ascii").digest("base64url");
const clientIdOf = (key: string) => `com.example.conformance.${key.replace(/[^A-Za-z0-9]/g, "")}`;
const signInReturn = (key: string) => `${web}/apps/conformance-${key}/sign-in`;
const otherReturn = (key: string) => `${web}/apps/conformance-${key}/elsewhere`;
const fingerprint = (key: string) => Array.from(createHash("sha256").update(key).digest(), (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(":");

function configured(profile: CloudProfile) {
  return deploymentLayer(profile, "staging").pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ ...secrets }))));
}

function withoutGoogle(profile: ReturnType<typeof testProfile>) {
  const { google, ...staging } = profile.environments.staging;
  return { ...profile, environments: { ...profile.environments, staging: { ...staging, capabilities: staging.capabilities.filter((capability) => capability !== "managedGoogle") } } };
}

async function opened(): Promise<Cloud> {
  cloud ??= (async () => {
    const fakes = await startFakeServer();
    const google = googleIdentityFake(secrets.GOOGLE_CLIENT_SECRET ?? "");
    fakes.mount("/google/", google.handler);
    const profile = await Effect.runPromise(parseProfile(testProfile(fakes.url)));
    const off = await Effect.runPromise(parseProfile(withoutGoogle(testProfile(fakes.url))));
    const runtime = ManagedRuntime.make(Layer.mergeAll(configured(profile), storeLayer({ kind: "pglite", file: undefined }), FetchHttpClient.layer));
    const made: Cloud = { runtime, googleOff: configured(off), fakes, google };
    await settle(made, migrate({ digest: testDatabaseIdentity, environment: "staging", now: 0 }));
    return made;
  })();
  return cloud;
}

async function settle<A, E>(made: Cloud, program: Effect.Effect<A, E, CloudContext>): Promise<A> {
  const exit = await made.runtime.runPromiseExit(Effect.provideService(program, Clock.Clock, time.clock));
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error(`the cloud failed: ${Cause.pretty(exit.cause)}`);
}

async function run<A, E>(program: Effect.Effect<A, E, CloudContext>): Promise<A> {
  return settle(await opened(), program);
}

const inTx = <A, E>(body: (tx: Tx) => Effect.Effect<A, E, Deployment>) => Effect.gen(function* () {
  const store = yield* Store;
  return yield* store.transaction(body);
});

async function sql(text: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<Row>> {
  return run(inTx((tx) => tx.query(text, params)));
}

function at(milliseconds: number) {
  now = milliseconds;
  time.set(milliseconds);
}

async function call(method: "POST" | "DELETE", path: string, init: { readonly json?: unknown; readonly bearer?: string; readonly googleOff?: boolean }): Promise<Answered> {
  const made = await opened();
  addresses += 1;
  const headers: Record<string, string> = {};
  if (init.json !== undefined) headers["content-type"] = "application/json";
  if (init.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`;
  const request = HttpServerRequest.fromWeb(new Request(`https://api.staging.example.com${path}`, { method, headers, body: init.json === undefined ? undefined : JSON.stringify(init.json) }))
    .modify({ remoteAddress: Option.some(`10.${(addresses >> 16) & 255}.${(addresses >> 8) & 255}.${addresses & 255}`) });
  const answering = Effect.provideService(respond(routes), HttpServerRequest.HttpServerRequest, request);
  const answer = await settle(made, init.googleOff === true ? Effect.provide(answering, made.googleOff) : answering);
  const response = HttpServerResponse.toWeb(answer);
  const text = await response.text();
  const parsed: unknown = text === "" ? {} : JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${method} ${path} answered ${response.status} with ${text}`);
  return { status: response.status, body: Object.fromEntries(Object.entries(parsed)) };
}

function outcome(answered: Answered, what: string): "accepted" | "refused" {
  if (answered.status === 200 || answered.status === 204) return "accepted";
  if ([400, 401, 403, 404, 409].includes(answered.status)) return "refused";
  if (answered.status === 503 && answered.body.reason === "google_not_configured") return "refused";
  throw new Error(`${what} answered ${answered.status}: ${JSON.stringify(answered.body)}`);
}

async function person(key: string): Promise<Person> {
  const known = people.get(key);
  if (known !== undefined) return known;
  const google: GooglePerson = { subject: `google-${key}`, email: `${key}@example.com`, emailVerified: true, givenName: key };
  const landed = await run(inTx((tx) => landAccount(tx, { method: "GoogleSignIn", subject: google.subject }, google.email, now, key)));
  const [account] = await sql("SELECT devices_revoked_before FROM accounts WHERE key = $1", [landed.userId]);
  const made: Person = { userId: landed.userId, organizationId: landed.organizationId, google, marks: [Number(account?.devices_revoked_before ?? 0)], factor: false };
  people.set(key, made);
  return made;
}

async function atEpoch(key: string, wanted: number) {
  const who = await person(key);
  while (who.marks.length <= wanted) {
    await run(inTx((tx) => revokeAll(tx, who.userId, now)));
    const [account] = await sql("SELECT devices_revoked_before FROM accounts WHERE key = $1", [who.userId]);
    who.marks.push(Number(account?.devices_revoked_before));
  }
  await sql("UPDATE accounts SET devices_revoked_before = $2 WHERE key = $1", [who.userId, who.marks[Math.max(0, wanted)]]);
}

async function session(who: Person, issuedAt: number) {
  return run(inTx((tx) => issueSession(tx, { userId: who.userId, organizationId: who.organizationId, assurance: "SingleFactor", accountCreated: false, now: issuedAt })));
}

async function register(key: string, wanted: { readonly credentialTtl: number; readonly nativeGoogle: boolean }): Promise<boolean> {
  const clientId = clientIdOf(key);
  const held = registered.get(clientId);
  if (held !== undefined && held.credentialTtl === wanted.credentialTtl && held.nativeGoogle === wanted.nativeGoogle) return true;
  const input = {
    clientId,
    environment: "staging",
    displayName: `Conformance ${key}`,
    androidPackage: `${clientId}.app`,
    certFingerprints: [fingerprint(key)],
    signInReturn: signInReturn(key),
    billingReturn: `${web}/apps/conformance-${key}/billing`,
    credentialTtlMs: wanted.credentialTtl,
    nativeGoogle: wanted.nativeGoogle,
    enabled: true,
  };
  const kept = await run(Effect.result(inTx((tx) => Effect.flatMap(Effect.zip(decodeRegistration(input), readClient(tx, clientId)), ([registration, current]) =>
    current === undefined ? registerClient(tx, registration, now) : updateClient(tx, registration, now)))));
  if (kept._tag === "Failure") return false;
  registered.set(clientId, wanted);
  return true;
}

async function asClient<A>(key: string, check: ClientCheck, send: (target: Target) => Promise<A>): Promise<A> {
  const clientId = clientIdOf(key);
  if (check.tag === "ClientAdmitted") return send({ clientId, redirectUri: signInReturn(key) });
  switch (check.fault) {
    case "UnknownClient":
      return send({ clientId: `${clientId}.unregistered`, redirectUri: signInReturn(key) });
    case "WrongRedirect":
      return send({ clientId, redirectUri: otherReturn(key) });
    case "DisabledClient": {
      const held = registered.get(clientId);
      if (held === undefined) return send({ clientId: `${clientId}.unregistered`, redirectUri: signInReturn(key) });
      await run(inTx((tx) => disableClient(tx, clientId, now)));
      registered.delete(clientId);
      try {
        return await send({ clientId, redirectUri: signInReturn(key) });
      } finally {
        await register(key, held);
      }
    }
    default: {
      const unknown: never = check.fault;
      throw new Error(`not a client fault: ${String(unknown)}`);
    }
  }
}

async function presenting<A>(key: string, view: CredentialView, send: (bearer: string) => Promise<A>): Promise<A> {
  if (!view.found) return send(`eliza_session_${randomBytes(32).toString("base64url").slice(0, 43)}`);
  if (view.kind === "RequestDevice") return send(`eliza_mobile_${hex(32)}`);
  const who = await person(key);
  if (accessLifetime === undefined) {
    const probe = await session(who, view.expiresAt);
    accessLifetime = probe.accessExpiresAt - view.expiresAt;
  }
  const signed = await session(who, view.expiresAt - accessLifetime);
  if (!view.live || view.issuedAt < view.revokedBefore) await run(inTx((tx) => revokeAllSessions(tx, who.userId, now)));
  if (view.accountStatus === "RequestAccountActive") return send(signed.accessToken);
  await sql("UPDATE accounts SET status = 'deleting' WHERE key = $1", [who.userId]);
  try {
    return await send(signed.accessToken);
  } finally {
    await sql("UPDATE accounts SET status = 'active' WHERE key = $1", [who.userId]);
  }
}

async function secondFactor(key: string, wanted: boolean) {
  const who = await person(key);
  if (who.factor === wanted) return;
  if (!wanted) {
    await sql("DELETE FROM second_factors WHERE key = $1", [who.userId]);
    who.factor = false;
    return;
  }
  const bearer = (await session(who, now)).accessToken;
  const enrolled = await call("POST", "/api/v1/auth/mfa/totp/enroll", { bearer, json: {} });
  const secret = enrolled.body.secret;
  if (typeof secret !== "string") throw new Error(`enrolling a second factor answered ${enrolled.status}: ${JSON.stringify(enrolled.body)}`);
  const confirmed = await call("POST", "/api/v1/auth/mfa/totp/confirm", { bearer, json: { code: authenticatorCode(secret, now) } });
  if (confirmed.status !== 200) throw new Error(`confirming a second factor answered ${confirmed.status}: ${JSON.stringify(confirmed.body)}`);
  who.factor = true;
}

function codeBody(request: CodeRequest, target: Target, state: string) {
  return { clientId: target.clientId, environment: "staging", redirectUri: target.redirectUri, ...(request.hasState ? { state } : {}) };
}

async function grantOf(column: "user_id" | "credential_id", value: string): Promise<string> {
  const [found] = await sql(`SELECT key FROM device_grants WHERE ${column} = $1 ORDER BY issued_at DESC, key DESC LIMIT 1`, [value]);
  if (typeof found?.key !== "string") throw new Error(`a grant was answered but none is kept for ${column} ${value}`);
  return found.key;
}

function credentialOf(answered: Answered, what: string) {
  const { credentialId, secret } = answered.body;
  if (typeof credentialId !== "string" || typeof secret !== "string" || !/^eliza_mobile_[0-9a-f]{64}$/.test(secret) || answered.body.acknowledgementRequired !== true || answered.body.tokenType !== "Bearer") {
    throw new Error(`${what} answered no credential: ${JSON.stringify(answered.body)}`);
  }
  return { credentialId, secret };
}

const method = (request: CodeRequest) => request.method === "S256" ? "S256" : "plain";

async function connect(key: string, event: Extract<Event, { type: "connect" }>) {
  if (devices.has(key)) return "refused" as const;
  const who = await person(key);
  const fits = await register(key, { credentialTtl: event.credentialTtl, nativeGoogle: true });
  await atEpoch(key, event.deviceEpoch);
  const verifier = hex(32);
  const state = hex(32);
  const answered = await presenting(key, event.view, (bearer) => asClient(key, fits ? event.codeRequest.client : { tag: "ClientRefused", fault: "UnknownClient" }, (target) =>
    call("POST", "/api/v1/app-auth/connect", {
      bearer,
      json: { ...codeBody(event.codeRequest, target, state), codeChallenge: s256(verifier), codeChallengeMethod: method(event.codeRequest), deviceName: `Phone ${key}` },
    })));
  const result = outcome(answered, "connect");
  if (result === "refused") return result;
  const code = answered.body.code;
  if (typeof code !== "string" || !/^emac_[0-9a-f]{64}$/.test(code) || answered.body.codeType !== "mobile_app_auth_code") throw new Error(`connect answered no code: ${JSON.stringify(answered.body)}`);
  devices.set(key, { grantKey: await grantOf("user_id", who.userId), code, state, verifier });
  return result;
}

async function signInNatively(key: string, event: Extract<Event, { type: "signInNatively" }>) {
  if (devices.has(key)) return "refused" as const;
  if (event.yielded !== "DeviceKeyYield" && event.yielded !== "SecondFactorYield") throw new Error(`the native Google route cannot yield ${event.yielded}`);
  const { google } = await opened();
  const who = await person(key);
  const fits = await register(key, { credentialTtl: event.credentialTtl, nativeGoogle: event.nativeGoogle !== "NativeGoogleNotRegistered" });
  await atEpoch(key, event.deviceEpoch);
  await secondFactor(key, event.yielded === "SecondFactorYield");
  const challengeVerifier = hex(32);
  const verifier = hex(32);
  const state = hex(32);
  const googleOff = event.nativeGoogle === "GoogleNotOffered";
  const answered = await asClient(key, fits ? event.codeRequest.client : { tag: "ClientRefused", fault: "UnknownClient" }, async (target) => {
    const asked = now;
    if (event.verdict === "NativeExpired") at(asked - 86_400_000);
    const challenge = await call("POST", "/api/v1/auth/google/native/challenge", {
      googleOff,
      json: { clientId: target.clientId, environment: "staging", redirectUri: target.redirectUri, codeChallenge: s256(challengeVerifier), codeChallengeMethod: method(event.codeRequest) },
    });
    at(asked);
    const { challengeId, nonce } = challenge.body;
    const live = challenge.status === 200 && typeof challengeId === "string" && typeof nonce === "string" && event.verdict !== "NativeUnknown";
    const idToken = await google.idToken(who.google, { audience: serverClientId, nonce: live && event.verdict !== "NativeProofWrong" ? nonce : hex(16) });
    return call("POST", "/api/v1/app-auth/mobile/google", {
      googleOff,
      json: {
        ...codeBody(event.codeRequest, target, state),
        codeVerifier: verifier,
        deviceName: `Phone ${key}`,
        identity: { challengeId: live ? challengeId : randomUUID(), idToken, codeVerifier: challengeVerifier },
        ...(event.serverCode === "WithServerCode" ? { serverAuthCode: google.serverAuthCode(who.google, ["openid", "email"]) } : {}),
      },
    });
  });
  const result = outcome(answered, "native sign-in");
  if (result === "refused" || answered.body.status === "mfa_required") return "refused" as const;
  if (answered.body.status !== "signed_in" || typeof answered.body.code !== "string") throw new Error(`native sign-in answered ${JSON.stringify(answered.body)}`);
  const minted = credentialOf(answered, "native sign-in");
  devices.set(key, { grantKey: await grantOf("credential_id", minted.credentialId), code: answered.body.code, state, verifier, minted });
  return result;
}

async function token(key: string, event: Extract<Event, { type: "token" }>) {
  const device = devices.get(key);
  await atEpoch(key, event.deviceEpoch);
  const answered = await asClient(key, event.client, (target) => call("POST", "/api/v1/app-auth/mobile/token", {
    json: {
      clientId: target.clientId,
      environment: "staging",
      redirectUri: event.binding === "RedirectDiffers" ? otherReturn(key) : target.redirectUri,
      grantType: "authorization_code",
      code: device?.code ?? `emac_${hex(32)}`,
      state: device?.state ?? hex(32),
      codeVerifier: device !== undefined && event.binding !== "VerifierDiffers" ? device.verifier : hex(32),
    },
  }));
  const result = outcome(answered, "token");
  if (result === "refused") return result;
  if (device === undefined) throw new Error(`token without a code answered ${JSON.stringify(answered.body)}`);
  const minted = credentialOf(answered, "token");
  if (device.minted !== undefined && (device.minted.credentialId !== minted.credentialId || device.minted.secret !== minted.secret)) {
    throw new Error("a repeated exchange before the acknowledgement answered another credential instead of the sealed copy");
  }
  device.minted = minted;
  return result;
}

async function ack(key: string, event: Extract<Event, { type: "ack" }>) {
  const device = devices.get(key);
  await atEpoch(key, event.deviceEpoch);
  const credentialId = device?.minted?.credentialId ?? randomUUID();
  const answered = await asClient(key, event.client, (target) => call("POST", "/api/v1/app-auth/mobile/ack", {
    json: {
      credentialId,
      secret: device?.minted !== undefined && event.proofMatches ? device.minted.secret : `eliza_mobile_${hex(32)}`,
      clientId: target.clientId,
      environment: "staging",
      redirectUri: target.redirectUri,
      code: device?.code ?? `emac_${hex(32)}`,
      state: device?.state ?? hex(32),
      codeVerifier: device?.verifier ?? hex(32),
    },
  }));
  const result = outcome(answered, "ack");
  if (result === "accepted" && (answered.body.status !== "acknowledged" || answered.body.credentialId !== credentialId)) throw new Error(`ack answered ${JSON.stringify(answered.body)}`);
  return result;
}

async function selfRevoke(key: string, event: Extract<Event, { type: "selfRevoke" }>) {
  const minted = devices.get(key)?.minted;
  await atEpoch(key, event.deviceEpoch);
  return outcome(await call("DELETE", "/api/v1/api-keys/current", { bearer: minted?.secret ?? `eliza_mobile_${hex(32)}` }), "self-revoke");
}

async function sweep(key: string, phases: ReadonlyArray<string>) {
  const device = devices.get(key);
  if (device === undefined) return "refused" as const;
  const row = async () => (await sql("SELECT phase, revision FROM device_grants WHERE key = $1", [device.grantKey]))[0];
  const before = await row();
  if (before === undefined || !phases.includes(String(before.phase))) return "refused" as const;
  await run(sweepGrants());
  const after = await row();
  return after !== undefined && Number(after.revision) > Number(before.revision) ? "accepted" as const : "refused" as const;
}

async function dispatch(key: string, event: Event) {
  switch (event.type) {
    case "connect":
      return connect(key, event);
    case "elapse":
      if (event.elapsed <= 0) return "refused" as const;
      at(now + event.elapsed);
      return "accepted" as const;
    case "signInNatively":
      return signInNatively(key, event);
    case "token":
      return token(key, event);
    case "ack":
      return ack(key, event);
    case "selfRevoke":
      return selfRevoke(key, event);
    case "expire":
      return sweep(key, ["active"]);
    case "lapse":
      return sweep(key, ["code_issued", "exchanged"]);
    default: {
      const unknown: never = event;
      throw new Error(`not a device-key event: ${JSON.stringify(unknown)}`);
    }
  }
}

const phaseColumns: Readonly<Record<Exclude<GrantPhase["tag"], "Unissued">, string>> = {
  CodeIssued: "code_issued",
  Exchanged: "exchanged",
  Active: "active",
  Expired: "expired",
  Ended: "ended",
};

function seen(grant: Grant): Seen {
  return { phase: grant.phase, origin: grant.origin, codeExpiresAt: grant.codeExpiresAt, credentialTtl: grant.credentialTtl, credentialIssued: grant.credentialId !== "" };
}

async function observe(key: string): Promise<Seen> {
  const grantKey = devices.get(key)?.grantKey ?? `absent-${key}`;
  const grant = (await run(inTx((tx) => loadRow(tx, grants, grantKey, false)))).state;
  const [row] = await sql("SELECT phase, sealed_copy, secret_digest, credential_id, code_expires_at, key_expires_at FROM device_grants WHERE key = $1", [grantKey]);
  if (row === undefined) return seen(grant);
  const { phase } = grant;
  if (phase.tag === "Unissued") throw new Error(`device_grants keeps ${grantKey} as an unissued grant`);
  if (row.phase !== phaseColumns[phase.tag]) throw new Error(`device_grants.phase ${String(row.phase)} is not the kept phase ${phase.tag}`);
  if (Number(row.code_expires_at) !== grant.codeExpiresAt) throw new Error(`device_grants.code_expires_at ${String(row.code_expires_at)} is not ${grant.codeExpiresAt}`);
  if (phase.tag === "Active" && Number(row.key_expires_at) !== phase.keyExpiresAt) throw new Error(`device_grants.key_expires_at ${String(row.key_expires_at)} is not ${phase.keyExpiresAt}`);
  if ((row.credential_id ?? "") !== grant.credentialId) throw new Error(`device_grants.credential_id ${String(row.credential_id)} is not the kept credential ${grant.credentialId}`);
  if (phase.tag === "Exchanged" && (row.sealed_copy === null || row.secret_digest === null)) throw new Error("an exchanged grant keeps no sealed copy to answer again");
  if (phase.tag !== "Exchanged" && row.sealed_copy !== null) throw new Error(`a ${phase.tag} grant still keeps a sealed copy of its key`);
  return seen(grant);
}

export const driver: Driver<Seen> & AsyncDisposable = {
  reset: async () => {
    await opened();
    devices.clear();
    people.clear();
    registered.clear();
    at(0);
    await sql("TRUNCATE organizations, native_clients, rate_windows, oauth_attempts CASCADE");
  },
  dispatch,
  observe,
  [Symbol.asyncDispose]: async () => {
    const made = await cloud;
    cloud = undefined;
    await made?.runtime.dispose();
    await made?.fakes.close();
  },
};

export const options: Options<Seen> = { keys: ["device"], view: seen };
