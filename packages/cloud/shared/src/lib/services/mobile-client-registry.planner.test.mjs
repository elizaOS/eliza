import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseRegisteredMobileClients,
  planRegisteredMobileClientAppIdUpdate,
  selectRegisteredMobileClient,
} from "./mobile-client-registry.ts";

const PRIMARY = "11111111-1111-4111-8111-111111111111",
  OLD = "abcdefab-2222-4222-8222-222222222222",
  NEXT = "33333333-3333-4333-8333-333333333333",
  OTHER = "44444444-4444-4444-8444-444444444444";
const reserved = {
    clientId: "ai.elizaos.app",
    appId: PRIMARY,
    redirectUri: "https://eliza.app/auth/callback",
  },
  target = {
    clientId: "org.example.reader",
    appId: OLD,
    redirectUri: "https://eliza.app/reader/auth/callback",
    enabled: true,
    credentialTtlSeconds: 7776000,
  },
  other = {
    enabled: false,
    redirectUri: "https://eliza.app/other/auth/callback",
    appId: OTHER,
    clientId: "org.example.other",
    credentialTtlSeconds: 86400,
  };
test("full-array parse and single-appId plan preserve all other records, field values, ordering and TTL", () => {
  const tail = {
    clientId: "org.example.tail",
    appId: "55555555-5555-4555-8555-555555555555",
    redirectUri: "https://eliza.app/tail/auth/callback",
    enabled: true,
  };
  const rows = [other, target, tail];
  const raw = JSON.stringify(rows, null, 2),
    parsed = parseRegisteredMobileClients(raw, reserved);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.registrations, rows);
  const p = planRegisteredMobileClientAppIdUpdate(raw, target.clientId, NEXT, reserved);
  assert.equal(p.ok, true);
  assert.equal(p.changed, true);
  const next = JSON.parse(p.registryJson);
  assert.deepEqual(next, [other, { ...target, appId: NEXT }, tail]);
  assert.equal(next[1].credentialTtlSeconds, target.credentialTtlSeconds);
  assert.equal(
    selectRegisteredMobileClient(p.registryJson, target.clientId, reserved).registration.appId,
    NEXT,
  );
  assert.equal(raw, JSON.stringify(rows, null, 2));
});
test("already-correct UUID is an exact-byte no-op including harmless case differences", () => {
  const raw = `  ${JSON.stringify([other, target], null, 2)}\n`;
  for (const id of [OLD, OLD.toUpperCase()])
    assert.deepEqual(planRegisteredMobileClientAppIdUpdate(raw, target.clientId, id, reserved), {
      ok: true,
      changed: false,
      registryJson: raw,
    });
});
test("target absence, disabled target and primary selection cannot produce replacement JSON", () => {
  for (const rows of [[], [other], [{ ...target, enabled: false }]]) {
    const p = planRegisteredMobileClientAppIdUpdate(
      JSON.stringify(rows),
      target.clientId,
      NEXT,
      reserved,
    );
    assert.deepEqual(p, { ok: false, code: "invalid_client" });
  }
  assert.deepEqual(
    planRegisteredMobileClientAppIdUpdate(
      JSON.stringify([target]),
      reserved.clientId,
      NEXT,
      reserved,
    ),
    { ok: false, code: "invalid_client" },
  );
});
test("replacement UUID collisions and malformed or invalid non-target source fail closed", () => {
  for (const id of [PRIMARY, OTHER, "bad"]) {
    const p = planRegisteredMobileClientAppIdUpdate(
      JSON.stringify([other, target]),
      target.clientId,
      id,
      reserved,
    );
    assert.deepEqual(p, { ok: false, code: "server_configuration_error" });
  }
  for (const raw of [
    "{",
    JSON.stringify([{ ...other, credentialTtlSeconds: 1 }, target]),
    JSON.stringify([{ ...other, scopes: ["admin"] }, target]),
    JSON.stringify([other, target, { ...target, clientId: "org.example.duplicate" }]),
  ]) {
    const p = planRegisteredMobileClientAppIdUpdate(raw, target.clientId, NEXT, reserved);
    assert.equal(p.ok, false);
    assert.equal("registryJson" in p, false);
  }
});
