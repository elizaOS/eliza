// spec/cloud/nativeClients/deviceKeys.md, "Story: Sign a device in and keep its key"; spec/cloud/nativeClients/deviceKeys.md, "Story: Keep my phone signed in without a browser"
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Cause, Clock, ConfigProvider, Effect, Exit, Layer, ManagedRuntime, Option, Schema } from "effect";
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Driver, Options } from "../../gen/cloud__nativeClients__deviceKeys.conformance.ts";
import type { ClientBinding, Event, Grant, GrantEffect } from "../../gen/cloud__nativeClients__deviceKeys.ts";
import type { ClientCheck } from "../../gen/cloud__nativeClients__registry.ts";
import type { CloudContext } from "../../src/http/routes.vibe";
import { respond } from "../../src/http/server.vibe";
import { landAccount } from "../../src/identity/accounts.vibe";
import { routes as federatedRoutes } from "../../src/identity/federated.vibe";
import { routes as factorRoutes } from "../../src/identity/second-factor.vibe";
import { issueSession } from "../../src/identity/sessions.vibe";
import { acknowledgeGrant, exchangeGrant, openGrant, renewGrant, retireGrant, routes, supersedeGrant } from "../../src/native-clients/device-keys.vibe";
import { observeGrant } from "../../src/native-clients/grants.vibe";
import { signInDevice } from "../../src/native-clients/mobile-google.vibe";
import { decodeRegistration, readClient, registerClient, updateClient } from "../../src/native-clients/registry.vibe";
import { deploymentLayer, parseProfile } from "@elizaos/cloud";
import { tokenDigest } from "../../src/shared/sealing.vibe";
import { Store, type Row, type Tx } from "../../src/store/connection.vibe";
import { migrate, storeLayer } from "../../src/store/store.vibe";
import { authenticatorCode } from "../support/authenticator.ts";
import { manualClock } from "../support/clock.ts";
import { startFakeServer, type FakeServer } from "../support/fakes.ts";
import { googleIdentityFake, type GoogleIdentityFake, type GooglePerson } from "../support/google-identity-fake.ts";
import { secrets, testDatabaseIdentity, testProfile } from "../support/profile.ts";

interface Person {
  readonly userId: string;
  readonly organizationId: string;
  readonly email: string;
  readonly accessToken: string;
  readonly sessionKey: string;
}

interface Device {
  readonly grantKey: string;
  readonly verifier: string;
  readonly state: string;
  readonly person: Person;
  readonly binding?: ClientBinding;
  readonly code?: string;
  readonly minted?: { readonly credentialId: string; readonly secret: string; readonly logicalId: string };
}

const time = manualClock();
const devices = new Map<string, Device>();
const outputs = new Map<string, ReadonlyArray<GrantEffect>>();
const ReplyObject = Schema.Record(Schema.String, Schema.Unknown);
const NativeChallengeReply = Schema.Struct({ challengeId: Schema.String, nonce: Schema.String, serverClientId: Schema.String, expiresAt: Schema.Int });
const AuthenticatorReply = Schema.Struct({ secret: Schema.String });
const originalBinding: ClientBinding = { clientId: "app.one", environment: "Staging", signInReturn: { origin: "https://www.staging.example.com", path: "/apps/conformance-1/sign-in" } };
const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const s256 = (verifier: string) => createHash("sha256").update(verifier, "ascii").digest("base64url");
const urlOf = (binding: ClientBinding) => binding.signInReturn.origin + binding.signInReturn.path;
const wireBinding = (binding: ClientBinding) => ({ clientId: binding.clientId, environment: binding.environment === "Production" ? "production" as const : "staging" as const, redirectUri: urlOf(binding) });
const within = <A, E, R>(body: (tx: Tx) => Effect.Effect<A, E, R>) => Effect.gen(function* () {
  const store = yield* Store;
  return yield* store.transaction(body);
});

function cloudRuntime(profile: Parameters<typeof deploymentLayer>[0]) {
  return ManagedRuntime.make(Layer.mergeAll(deploymentLayer(profile, "staging"), storeLayer({ kind: "pglite", file: undefined }), FetchHttpClient.layer)
    .pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ ...secrets })))));
}

let runtime: ReturnType<typeof cloudRuntime> | undefined;
let fakes: FakeServer | undefined;
let google: GoogleIdentityFake | undefined;
let googleOff: Parameters<typeof deploymentLayer>[0] | undefined;
let now = 0;
let identities = 0;
let requests = 0;

async function opened() {
  if (runtime !== undefined) return;
  fakes = await startFakeServer();
  google = googleIdentityFake(secrets.GOOGLE_CLIENT_SECRET ?? "");
  fakes.mount("/google/", google.handler);
  const input = testProfile(fakes.url);
  const { google: _google, ...staging } = input.environments.staging;
  googleOff = await Effect.runPromise(parseProfile({ ...input, environments: { ...input.environments, staging: { ...staging, capabilities: staging.capabilities.filter((value) => value !== "managedGoogle") } } }));
  runtime = cloudRuntime(await Effect.runPromise(parseProfile(input)));
  await run(migrate({ digest: testDatabaseIdentity, environment: "staging", now: 0 }));
}

async function settled<A, E>(program: Effect.Effect<A, E, CloudContext>, off = false) {
  await opened();
  if (runtime === undefined) throw new Error("the cloud runtime did not open");
  const selected = off && googleOff !== undefined
    ? Effect.provide(program, deploymentLayer(googleOff, "staging").pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ ...secrets })))))
    : program;
  return runtime.runPromiseExit(Effect.provideService(selected, Clock.Clock, time.clock));
}

async function run<A, E>(program: Effect.Effect<A, E, CloudContext>, off = false): Promise<A> {
  const exit = await settled(program, off);
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error(`the cloud failed: ${Cause.pretty(exit.cause)}`);
}

async function attempt<A, E>(program: Effect.Effect<A, E, CloudContext>, off = false): Promise<{ readonly accepted: true; readonly value: A } | { readonly accepted: false }> {
  const exit = await settled(program, off);
  if (Exit.isSuccess(exit)) return { accepted: true, value: exit.value };
  const failure: unknown = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (typeof failure === "object" && failure !== null && "_tag" in failure && (failure._tag === "Refused" || failure._tag === "Rejected")) return { accepted: false };
  throw new Error(`the cloud failed: ${Cause.pretty(exit.cause)}`);
}

async function call(path: string, body: unknown, bearer?: string, off = false) {
  requests += 1;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  const request = HttpServerRequest.fromWeb(new Request(`https://api.staging.example.com${path}`, { method: "POST", headers, body: JSON.stringify(body) }))
    .modify({ remoteAddress: Option.some(`10.${(requests >> 16) & 255}.${(requests >> 8) & 255}.${requests & 255}`) });
  const answer = await run(Effect.provideService(respond([...routes, ...federatedRoutes, ...factorRoutes]), HttpServerRequest.HttpServerRequest, request), off);
  const response = HttpServerResponse.toWeb(answer);
  const parsed: unknown = await response.json();
  return { status: response.status, body: Schema.decodeUnknownSync(ReplyObject)(parsed) };
}

async function person(key: string): Promise<Person> {
  identities += 1;
  const email = `${key}-${identities}@example.com`;
  const landed = await run(within((tx) => landAccount(tx, { method: "EmailSignIn", subject: email }, email, now)));
  const signed = await run(within((tx) => issueSession(tx, { ...landed, assurance: "SingleFactor", accountCreated: false, now })));
  const rows = await run(within((tx) => tx.query("SELECT key FROM sessions WHERE access_digest = $1", [tokenDigest(signed.accessToken)])));
  const sessionKey = rows[0]?.key;
  if (typeof sessionKey !== "string") throw new Error("the issued session has no persisted row");
  return { userId: landed.userId, organizationId: landed.organizationId, email, accessToken: signed.accessToken, sessionKey };
}

async function device(key: string): Promise<Device> {
  const known = devices.get(key);
  if (known !== undefined) return known;
  const made: Device = { grantKey: randomUUID(), verifier: hex(32), state: hex(32), person: await person(key) };
  devices.set(key, made);
  return made;
}

async function row(key: string): Promise<Row | undefined> {
  return (await run(within((tx) => tx.query("SELECT phase, credential_id, sealed_copy, secret_digest, code_expires_at, key_expires_at FROM device_grants WHERE key = $1", [key]))))[0];
}

async function configureClient(binding: ClientBinding, ttl: number, check: ClientCheck, nativeGoogle = true) {
  if (check.tag === "ClientRefused" && check.fault === "UnknownClient") {
    await run(within((tx) => tx.query("DELETE FROM native_clients WHERE client_id = $1", [binding.clientId])));
    return;
  }
  const redirect = check.tag === "ClientRefused" && check.fault === "WrongRedirect" ? `${urlOf(binding)}/registered` : urlOf(binding);
  const input = {
    clientId: binding.clientId, environment: binding.environment === "Production" ? "production" as const : "staging" as const,
    displayName: "Conformance", androidPackage: `com.example.app${createHash("sha256").update(binding.clientId).digest("hex").slice(0, 12)}`,
    certFingerprints: [Array.from(createHash("sha256").update(binding.clientId).digest(), (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(":")],
    signInReturn: redirect, billingReturn: `${urlOf(binding)}/billing`, credentialTtlMs: ttl, nativeGoogle,
    enabled: check.tag !== "ClientRefused" || check.fault !== "DisabledClient",
  };
  await run(within((tx) => Effect.gen(function* () {
    const current = yield* readClient(tx, binding.clientId);
    const registration = yield* decodeRegistration(input);
    return yield* (current === undefined ? registerClient(tx, registration, now) : updateClient(tx, registration, now));
  })));
}

async function epoch(subject: Person, value: number) {
  await run(within((tx) => Effect.gen(function* () {
    yield* tx.query("UPDATE accounts SET status = 'active', device_epoch = $2 WHERE key = $1", [subject.userId, value]);
    yield* tx.query("UPDATE device_grants SET device_epoch = $2 WHERE user_id = $1 AND state ? 'flatDeviceGrant'", [subject.userId, value]);
  })));
}

const day = 86_400_000;

function activeState(binding: ClientBinding, expiresAt: number, grantEpoch: number, credentialId: string) {
  const credentialTtl = Math.min(90 * day, Math.max(day, expiresAt - now));
  const ackedAt = expiresAt - credentialTtl;
  const grant: Grant = {
    phase: { tag: "Active", ackedAt, keyExpiresAt: expiresAt }, origin: { tag: "Connected" }, client: { tag: "BoundClient", ...binding },
    codeExpiresAt: ackedAt + 300_000, credentialTtl, credentialId, epoch: grantEpoch, now: Math.max(now, ackedAt),
  };
  return grant;
}

async function insertKey(subject: Person, key: string, grant: Grant, signInAt: number, renewedFrom: string | null) {
  const secret = `eliza_mobile_${hex(32)}`;
  const expiresAt = grant.phase.tag === "Active" ? grant.phase.keyExpiresAt : 0;
  await run(within((tx) => tx.query(
    "INSERT INTO device_grants (key, state, revision, user_id, client_id, phase, credential_id, secret_digest, code_expires_at, key_expires_at, device_epoch, issued_at, sign_in_at, renewed_from, updated_at) VALUES ($1, $2::jsonb, 1, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11, $12, $10)",
    [key, JSON.stringify(grant), subject.userId, grant.client.tag === "BoundClient" ? grant.client.clientId : "", grant.credentialId, tokenDigest(secret), grant.codeExpiresAt, expiresAt, grant.epoch, grant.now, signInAt, renewedFrom],
  )));
}

async function renew(key: string, event: Extract<Event, { type: "renew" }>) {
  const held = await device(key);
  await configureClient(event.clientBinding, event.registrationTtl, event.codeRequest.client);
  await epoch(held.person, event.deviceEpoch);
  const predecessorKey = randomUUID();
  const recorded: ClientBinding = event.facts.clientMatches ? event.clientBinding : { ...event.clientBinding, signInReturn: { ...event.clientBinding.signInReturn, path: `${event.clientBinding.signInReturn.path}/earlier` } };
  const predecessorEpoch = event.facts.predecessor === "CredentialRevoked" ? event.deviceEpoch - 1 : event.deviceEpoch;
  const expiresAt = event.facts.predecessor === "CredentialExpired" ? now : event.facts.predecessorExpiresAt;
  await insertKey(held.person, predecessorKey, activeState(recorded, expiresAt, predecessorEpoch, randomUUID()), event.facts.signInAt, null);
  if (event.facts.successorAcknowledged) {
    await insertKey(held.person, randomUUID(), { ...activeState(event.clientBinding, now + day, event.deviceEpoch, randomUUID()), origin: { tag: "Renewed" } }, event.facts.signInAt, predecessorKey);
  }
  const answer = await attempt(within((tx) => renewGrant(tx, {
    grantKey: held.grantKey, predecessorKey,
    request: { ...wireBinding(event.clientBinding), state: event.codeRequest.hasState ? held.state : "absent", codeChallenge: s256(held.verifier), codeChallengeMethod: event.codeRequest.method, deviceName: "Conformance phone" },
  })));
  if (!answer.accepted || answer.value.kind !== "issued") return "refused" as const;
  await run(within((tx) => tx.query("UPDATE device_grants SET state = $2::jsonb, phase = 'active', key_expires_at = $3 WHERE key = $1", [predecessorKey, JSON.stringify({ flatDeviceGrant: "FlatTokenStarted" }), Number.MAX_SAFE_INTEGER])));
  devices.set(key, { ...held, code: answer.value.code, binding: event.clientBinding });
  return "accepted" as const;
}

function keep(key: string, before: Device, credential: { readonly credentialId: string; readonly secret: string }, logicalId: string, out: ReadonlyArray<GrantEffect>, code?: string, binding?: ClientBinding) {
  if (before.minted !== undefined && (credential.credentialId !== before.minted.credentialId || credential.secret !== before.minted.secret)) throw new Error("the repeated exchange returned a different credential");
  devices.set(key, { ...before, ...(code === undefined ? {} : { code }), ...(binding === undefined ? {} : { binding }), minted: { ...credential, logicalId: before.minted?.logicalId ?? logicalId } });
  outputs.set(key, out);
}

async function connect(key: string, event: Extract<Event, { type: "connect" }>) {
  const held = await device(key);
  await configureClient(event.clientBinding, event.credentialTtl, event.codeRequest.client);
  await run(within((tx) => Effect.gen(function* () {
    yield* tx.query("UPDATE accounts SET status = $2, device_epoch = $3 WHERE key = $1", [held.person.userId, event.view.accountStatus === "RequestAccountActive" ? "active" : "deleting", event.deviceEpoch]);
    yield* tx.query("UPDATE sessions SET live = $2, access_expires_at = $3, refresh_expires_at = $4, auth_at = $5, step_up_at = $6, mfa_at = $7 WHERE key = $1", [held.person.sessionKey, event.view.live, event.view.expiresAt, Math.max(event.view.expiresAt, now + 1), event.view.issuedAt, event.view.stepUpAt, event.view.mfaAt]);
  })));
  const answer = await attempt(within((tx) => openGrant(tx, {
    grantKey: held.grantKey, userId: held.person.userId,
    sessionKey: event.view.found && event.view.kind === "RequestSession" ? held.person.sessionKey : randomUUID(),
    request: { ...wireBinding(event.clientBinding), state: event.codeRequest.hasState ? held.state : "absent", codeChallenge: s256(held.verifier), codeChallengeMethod: event.codeRequest.method, deviceName: "Conformance phone" },
  })));
  if (!answer.accepted) return "refused" as const;
  devices.set(key, { ...held, code: answer.value.code, binding: event.clientBinding });
  outputs.set(key, answer.value.out);
  return "accepted" as const;
}

async function native(key: string, event: Extract<Event, { type: "signInNatively" }>) {
  let held = await device(key);
  if (await row(held.grantKey) === undefined) {
    held = { ...held, person: await person(`${key}-google`) };
    devices.set(key, held);
  }
  await epoch(held.person, event.deviceEpoch);
  await configureClient(event.clientBinding, event.credentialTtl, event.codeRequest.client, event.nativeGoogle !== "NativeGoogleNotRegistered");
  const off = event.nativeGoogle === "GoogleNotOffered";
  if (event.yielded === "SecondFactorYield" && await row(held.grantKey) === undefined) {
    const enrolled = await call("/api/v1/auth/mfa/totp/enroll", {}, held.person.accessToken);
    if (enrolled.status !== 200) throw new Error("the authenticator was not enrolled");
    const { secret } = Schema.decodeUnknownSync(AuthenticatorReply)(enrolled.body);
    const confirmed = await call("/api/v1/auth/mfa/totp/confirm", { code: authenticatorCode(secret, now) }, held.person.accessToken);
    if (confirmed.status !== 200) throw new Error("the authenticator was not confirmed");
  }
  const verifier = "c".repeat(43);
  const challenge = await call("/api/v1/auth/google/native/challenge", { ...wireBinding(event.clientBinding), codeChallenge: s256(verifier), codeChallengeMethod: event.codeRequest.method }, undefined, off);
  if (challenge.status !== 200) return "refused" as const;
  const { challengeId, nonce, serverClientId } = Schema.decodeUnknownSync(NativeChallengeReply)(challenge.body);
  if (google === undefined) throw new Error("the Google boundary did not open");
  const who: GooglePerson = { subject: `google-${held.person.userId}`, email: held.person.email, emailVerified: true };
  const idToken = await google.idToken(who, { audience: serverClientId, nonce: event.verdict === "NativeAccepted" ? nonce : "different-nonce" });
  const serverAuthCode = event.serverCode === "WithServerCode" ? google.serverAuthCode(who, ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"]) : undefined;
  const answer = await attempt(signInDevice({ grantKey: held.grantKey, request: {
    ...wireBinding(event.clientBinding), state: event.codeRequest.hasState ? held.state : "absent", codeVerifier: held.verifier,
    identity: { challengeId, idToken, codeVerifier: verifier }, ...(serverAuthCode === undefined ? {} : { serverAuthCode }),
  } }), off);
  if (!answer.accepted || answer.value.kind === "mfa") return "refused" as const;
  keep(key, held, answer.value.answer, event.credentialId, answer.value.out, answer.value.answer.code, event.clientBinding);
  return "accepted" as const;
}

async function token(key: string, event: Extract<Event, { type: "token" }>) {
  const held = await device(key);
  const observed = await run(within((tx) => observeGrant(tx, held.grantKey)));
  const binding = held.binding ?? originalBinding;
  await epoch(held.person, event.deviceEpoch);
  await configureClient(binding, observed.credentialTtl || 86_400_000, event.client);
  const answer = await attempt(within((tx) => exchangeGrant(tx, {
    ...wireBinding(binding), redirectUri: event.binding === "RedirectDiffers" ? `${urlOf(binding)}/different` : urlOf(binding), grantType: "authorization_code",
    code: held.code ?? `emac_${hex(32)}`, state: held.state, codeVerifier: event.binding === "VerifierDiffers" ? hex(32) : held.verifier,
  })));
  if (!answer.accepted) return "refused" as const;
  keep(key, held, answer.value.credential, event.credentialId, answer.value.out);
  return "accepted" as const;
}

async function ack(key: string, event: Extract<Event, { type: "ack" }>) {
  const held = await device(key);
  const observed = await run(within((tx) => observeGrant(tx, held.grantKey)));
  await epoch(held.person, event.deviceEpoch);
  await configureClient(held.binding ?? originalBinding, observed.credentialTtl || 86_400_000, event.client);
  const answer = await attempt(within((tx) => acknowledgeGrant(tx, { credentialId: held.minted?.credentialId ?? randomUUID(), secret: event.proofMatches ? held.minted?.secret ?? `eliza_mobile_${hex(32)}` : `eliza_mobile_${hex(32)}` })));
  if (!answer.accepted) return "refused" as const;
  outputs.set(key, answer.value.out);
  return "accepted" as const;
}

async function observe(key: string): Promise<Grant> {
  const held = await device(key);
  const grant = await run(within((tx) => observeGrant(tx, held.grantKey)));
  const stored = await row(held.grantKey);
  if (stored !== undefined) {
    const phases: Readonly<Record<Grant["phase"]["tag"], string>> = { Unissued: "ended", CodeIssued: "code_issued", Exchanged: "exchanged", Active: "active", LegacyActive: "active", Expired: "expired", Ended: "ended" };
    if (stored.phase !== phases[grant.phase.tag] || Number(stored.code_expires_at) !== grant.codeExpiresAt) throw new Error("the grant columns disagree with the observed state");
    if ((grant.phase.tag === "Active" || grant.phase.tag === "LegacyActive") && Number(stored.key_expires_at) !== grant.phase.keyExpiresAt) throw new Error("the active key expiry differs from the stored expiry");
    if (grant.phase.tag === "Exchanged" ? typeof stored.sealed_copy !== "string" : stored.sealed_copy !== null) throw new Error("the recoverable key copy disagrees with the stored phase");
  }
  return { ...grant, credentialId: grant.credentialId === "" ? "" : held.minted?.logicalId ?? grant.credentialId };
}

async function dispatch(key: string, event: Event) {
  outputs.set(key, []);
  if (event.type === "elapse") {
    const before = await observe(key);
    time.set(before.now + event.elapsed);
    const after = await observe(key);
    if (after.now > before.now) { now = after.now; return "accepted" as const; }
    time.set(before.now);
    now = before.now;
    return "refused" as const;
  }
  switch (event.type) {
    case "connect": return connect(key, event);
    case "signInNatively": return native(key, event);
    case "token": return token(key, event);
    case "ack": return ack(key, event);
    case "selfRevoke": {
      const held = await device(key);
      await epoch(held.person, event.deviceEpoch);
      const request = HttpServerRequest.fromWeb(new Request("https://api.staging.example.com/api/v1/api-keys/current", { method: "DELETE", headers: { authorization: `Bearer ${held.minted?.secret ?? `eliza_mobile_${hex(32)}`}` } }));
      const response = await run(Effect.provideService(respond(routes), HttpServerRequest.HttpServerRequest, request));
      return response.status === 204 ? "accepted" as const : "refused" as const;
    }
    case "renew": return renew(key, event);
    case "supersede": {
      const held = await device(key);
      const answer = await attempt(within((tx) => supersedeGrant(tx, held.grantKey)));
      if (!answer.accepted) return "refused" as const;
      outputs.set(key, answer.value);
      return "accepted" as const;
    }
    case "lapse": case "expire": {
      const held = await device(key);
      const answer = await attempt(within((tx) => retireGrant(tx, held.grantKey, event.type)));
      if (!answer.accepted) return "refused" as const;
      outputs.set(key, answer.value);
      return "accepted" as const;
    }
    default: {
      const exhaustive: never = event;
      throw new Error(`unknown device event ${String(exhaustive)}`);
    }
  }
}

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    await opened();
    devices.clear();
    outputs.clear();
    now = 0;
    time.set(now);
    await run(within((tx) => tx.query("TRUNCATE organizations, native_clients, rate_windows, oauth_attempts CASCADE")));
  },
  dispatch,
  observe,
  observeOutput: (key) => outputs.get(key) ?? [],
  [Symbol.asyncDispose]: async () => {
    await runtime?.dispose();
    await fakes?.close();
    runtime = undefined;
    fakes = undefined;
    google = undefined;
  },
};

export const options: Options = { keys: ["device"] };
