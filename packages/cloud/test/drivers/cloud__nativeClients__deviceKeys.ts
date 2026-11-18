// spec/cloud/nativeClients/deviceKeys.md, "Story: Sign a device in and keep its key"
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Cause, Clock, ConfigProvider, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Driver, Options } from "../../gen/cloud__nativeClients__deviceKeys.conformance.ts";
import type { Event, Grant } from "../../gen/cloud__nativeClients__deviceKeys.ts";
import type { CloudContext } from "../../src/http/routes.vibe";
import { respond } from "../../src/http/server.vibe";
import { landAccount } from "../../src/identity/accounts.vibe";
import { issueSession } from "../../src/identity/sessions.vibe";
import { parseProfile } from "../../src/index.vibe";
import { grants, routes, sweepGrants } from "../../src/native-clients/device-keys.vibe";
import { decodeRegistration, readClient, registerClient, updateClient } from "../../src/native-clients/registry.vibe";
import { deploymentLayer } from "../../src/profile/profile.vibe";
import type { Row } from "../../src/store/connection.vibe";
import { loadRow } from "../../src/store/rows.vibe";
import { migrate, storeLayer } from "../../src/store/store.vibe";
import { manualClock } from "../support/clock.ts";
import { within } from "../support/ledger.ts";
import { secrets, testDatabaseIdentity, testProfile } from "../support/profile.ts";

interface Device {
  readonly userId: string;
  readonly clientId: string;
  readonly grantKey: string;
  readonly code: string;
  readonly verifier: string;
  readonly minted?: { readonly credentialId: string; readonly secret: string };
}

interface Answered {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

const web = "https://www.staging.example.com";
const time = manualClock();
const devices = new Map<string, Device>();
const clients = new Map<string, number>();
const people = new Map<string, { readonly userId: string; readonly organizationId: string }>();
let addresses = 0;

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const s256 = (verifier: string) => createHash("sha256").update(verifier, "ascii").digest("base64url");
const signInReturn = (index: number) => `${web}/apps/conformance-${index}/sign-in`;

function cloudRuntime(profile: Parameters<typeof deploymentLayer>[0]) {
  const platform = Layer.mergeAll(deploymentLayer(profile, "staging"), storeLayer({ kind: "pglite", file: undefined }), FetchHttpClient.layer);
  return ManagedRuntime.make(platform.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ ...secrets })))));
}

let runtime: ReturnType<typeof cloudRuntime> | undefined;

async function opened() {
  if (runtime !== undefined) return runtime;
  const made = cloudRuntime(await Effect.runPromise(parseProfile(testProfile("http://127.0.0.1:9"))));
  runtime = made;
  await run(migrate({ digest: testDatabaseIdentity, environment: "staging", now: 0 }));
  return made;
}

async function run<A, E>(program: Effect.Effect<A, E, CloudContext>): Promise<A> {
  const ready = runtime ?? (await opened());
  const exit = await ready.runPromiseExit(Effect.provideService(program, Clock.Clock, time.clock));
  if (Exit.isSuccess(exit)) return exit.value;
  throw new Error(`the cloud failed: ${Cause.pretty(exit.cause)}`);
}

async function call(method: "POST" | "DELETE", path: string, init: { readonly json?: unknown; readonly bearer?: string }): Promise<Answered> {
  addresses += 1;
  const headers: Record<string, string> = { "x-forwarded-for": `10.${(addresses >> 16) & 255}.${(addresses >> 8) & 255}.${addresses & 255}` };
  if (init.json !== undefined) headers["content-type"] = "application/json";
  if (init.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`;
  const request = new Request(`https://api.staging.example.com${path}`, { method, headers, body: init.json === undefined ? undefined : JSON.stringify(init.json) });
  const answer = await run(Effect.provideService(respond(routes), HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)));
  const response = HttpServerResponse.toWeb(answer);
  const text = await response.text();
  const parsed: unknown = text === "" ? {} : JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${method} ${path} answered ${response.status} with ${text}`);
  return { status: response.status, body: Object.fromEntries(Object.entries(parsed)) };
}

function outcome(answered: Answered, what: string): "accepted" | "refused" {
  if (answered.status === 200) return "accepted";
  if ([400, 401, 403, 404, 409].includes(answered.status)) return "refused";
  throw new Error(`${what} answered ${answered.status}: ${JSON.stringify(answered.body)}`);
}

async function client(clientId: string, credentialTtl: number, now: number) {
  const known = clients.get(clientId);
  const index = known ?? clients.size + 1;
  const input = {
    clientId,
    environment: "staging" as const,
    displayName: `Conformance ${index}`,
    androidPackage: `com.example.conformance${index}`,
    certFingerprints: [Array.from(createHash("sha256").update(clientId).digest(), (byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(":")],
    signInReturn: signInReturn(index),
    billingReturn: `${web}/apps/conformance-${index}/billing`,
    credentialTtlMs: credentialTtl,
    nativeGoogle: false,
    enabled: true,
  };
  await run(within((tx) => Effect.flatMap(readClient(tx, clientId), (current) => Effect.flatMap(decodeRegistration(input), (registration) =>
    current === undefined ? registerClient(tx, registration, now) : current.credentialTtl === credentialTtl ? Effect.succeed(current) : updateClient(tx, registration, now)))));
  clients.set(clientId, index);
  return index;
}

async function person(key: string) {
  const known = people.get(key);
  if (known !== undefined) return known;
  const landed = await run(within((tx) => landAccount(tx, { method: "EmailSignIn", subject: `${key}@example.com` }, `${key}@example.com`, 0)));
  const made = { userId: landed.userId, organizationId: landed.organizationId };
  people.set(key, made);
  return made;
}

async function grantRow(grantKey: string): Promise<Row | undefined> {
  const rows = await run(within((tx) => tx.query("SELECT revision, phase, sealed_copy, secret_digest, code_expires_at, key_expires_at FROM device_grants WHERE key = $1", [grantKey])));
  return rows[0];
}

async function connect(key: string, event: Extract<Event, { type: "connect" }>) {
  if (devices.has(key)) return "refused" as const;
  const index = await client(event.clientId, event.credentialTtl, event.now);
  const owner = await person(key);
  const signed = await run(within((tx) => issueSession(tx, { ...owner, assurance: "SingleFactor", accountCreated: false, now: event.now })));
  const verifier = hex(32);
  const answered = await call("POST", "/api/v1/app-auth/connect", {
    bearer: signed.accessToken,
    json: { clientId: event.clientId, environment: "staging", redirectUri: signInReturn(index), state: hex(16), codeChallenge: s256(verifier), codeChallengeMethod: "S256", deviceName: `Phone ${key}` },
  });
  const result = outcome(answered, "connect");
  if (result === "refused") return result;
  const code = answered.body.code;
  if (typeof code !== "string" || !/^emac_[0-9a-f]{64}$/.test(code) || answered.body.codeType !== "mobile_app_auth_code") throw new Error(`connect answered no code: ${JSON.stringify(answered.body)}`);
  const found = await run(within((tx) => tx.query("SELECT key FROM device_grants WHERE user_id = $1 AND client_id = $2 ORDER BY issued_at DESC, key DESC LIMIT 1", [owner.userId, event.clientId])));
  const grantKey = found[0]?.key;
  if (typeof grantKey !== "string") throw new Error("connect answered a code but kept no grant");
  devices.set(key, { userId: owner.userId, clientId: event.clientId, grantKey, code, verifier });
  return result;
}

async function token(key: string, event: Extract<Event, { type: "token" }>) {
  const device = devices.get(key);
  const index = device === undefined ? undefined : clients.get(device.clientId);
  const body = {
    clientId: device?.clientId ?? "unregistered.conformance",
    environment: "staging",
    redirectUri: index === undefined ? `${web}/apps/unregistered/sign-in` : signInReturn(index),
    grantType: "authorization_code",
    code: device?.code ?? `emac_${hex(32)}`,
    state: hex(16),
    codeVerifier: device !== undefined && event.verifierMatches ? device.verifier : hex(32),
  };
  const answered = await call("POST", "/api/v1/app-auth/mobile/token", { json: body });
  const result = outcome(answered, "token");
  if (result === "refused" || device === undefined) return result;
  const { credentialId, secret } = answered.body;
  if (typeof credentialId !== "string" || typeof secret !== "string" || !/^eliza_mobile_[0-9a-f]{64}$/.test(secret) || answered.body.acknowledgementRequired !== true || answered.body.tokenType !== "Bearer") {
    throw new Error(`token answered no credential: ${JSON.stringify(answered.body)}`);
  }
  if (device.minted !== undefined && (device.minted.credentialId !== credentialId || device.minted.secret !== secret)) {
    throw new Error("a repeated token before acknowledgement answered a different credential instead of the sealed copy");
  }
  devices.set(key, { ...device, minted: { credentialId, secret } });
  return result;
}

async function ack(key: string, event: Extract<Event, { type: "ack" }>) {
  const minted = devices.get(key)?.minted;
  const credentialId = minted?.credentialId ?? randomUUID();
  const secret = minted !== undefined && event.secretMatches ? minted.secret : `eliza_mobile_${hex(32)}`;
  const answered = await call("POST", "/api/v1/app-auth/mobile/ack", { json: { credentialId, secret } });
  const result = outcome(answered, "ack");
  if (result === "accepted" && (answered.body.status !== "acknowledged" || answered.body.credentialId !== credentialId)) {
    throw new Error(`ack answered ${JSON.stringify(answered.body)}`);
  }
  return result;
}

async function selfRevoke(key: string, event: Extract<Event, { type: "selfRevoke" }>) {
  const minted = devices.get(key)?.minted;
  const answered = await call("DELETE", "/api/v1/api-keys/current", { bearer: minted?.secret ?? `eliza_mobile_${hex(32)}` });
  const result = outcome(answered, "self-revoke");
  if (result === "accepted" && (answered.body.status !== "revoked" || answered.body.credentialId !== minted?.credentialId)) {
    throw new Error(`self-revoke answered ${JSON.stringify(answered.body)}`);
  }
  return result;
}

async function cleanup(key: string) {
  const device = devices.get(key);
  const before = device === undefined ? undefined : await grantRow(device.grantKey);
  await run(sweepGrants());
  const after = device === undefined ? undefined : await grantRow(device.grantKey);
  return before !== undefined && after !== undefined && Number(after.revision) > Number(before.revision) ? "accepted" as const : "refused" as const;
}

async function dispatch(key: string, event: Event) {
  time.set(event.now);
  switch (event.type) {
    case "connect":
      return connect(key, event);
    case "token":
      return token(key, event);
    case "ack":
      return ack(key, event);
    case "selfRevoke":
      return selfRevoke(key, event);
    case "cleanup":
      return cleanup(key);
    default: {
      const unknown: never = event;
      throw new Error(`not a device-key event: ${JSON.stringify(unknown)}`);
    }
  }
}

const phaseColumns: Readonly<Record<Grant["phase"]["tag"], string>> = {
  CodeIssued: "code_issued",
  Exchanged: "exchanged",
  Active: "active",
  Expired: "expired",
  Ended: "ended",
};

async function observe(key: string): Promise<Grant> {
  const grantKey = devices.get(key)?.grantKey ?? `absent-${key}`;
  const loaded = await run(within((tx) => loadRow(tx, grants, grantKey, false)));
  const row = await grantRow(grantKey);
  if (row === undefined) return loaded.state;
  const grant = loaded.state;
  if (row.phase !== phaseColumns[grant.phase.tag]) throw new Error(`device_grants.phase ${String(row.phase)} is not the kept phase ${grant.phase.tag}`);
  if (Number(row.code_expires_at) !== grant.codeExpiresAt) throw new Error(`device_grants.code_expires_at ${String(row.code_expires_at)} is not ${grant.codeExpiresAt}`);
  if (grant.phase.tag === "Active" && Number(row.key_expires_at) !== grant.keyExpiresAt) throw new Error(`device_grants.key_expires_at ${String(row.key_expires_at)} is not ${grant.keyExpiresAt}`);
  if (grant.phase.tag === "Exchanged" && (row.sealed_copy === null || row.secret_digest === null)) throw new Error("an exchanged grant keeps no sealed copy to replay");
  if (grant.phase.tag !== "Exchanged" && row.sealed_copy !== null) throw new Error(`a ${grant.phase.tag} grant still keeps a sealed copy of its key`);
  return grant;
}

export const driver: Driver & AsyncDisposable = {
  reset: async () => {
    await opened();
    devices.clear();
    clients.clear();
    people.clear();
    time.set(0);
    await run(within((tx) => tx.query("TRUNCATE organizations, native_clients, rate_windows CASCADE")));
  },
  dispatch,
  observe,
  [Symbol.asyncDispose]: async () => {
    await runtime?.dispose();
    runtime = undefined;
  },
};

export const options: Options = { keys: ["device"] };
