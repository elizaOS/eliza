import { describe, expect, test } from "bun:test";
import { selectRegisteredMobileClient } from "./mobile-client-registry";

const reserved = {
  clientId: "ai.elizaos.app",
  appId: "11111111-1111-4111-8111-111111111111",
  redirectUri: "https://eliza.app/auth/callback",
};
const senior = {
  clientId: "ai.elizaresearch.seniorcare",
  appId: "22222222-2222-4222-8222-222222222222",
  redirectUri: "https://cloud.eliza.app/auth/senior-care/callback",
  enabled: true,
};
const select = (entries: unknown, client = senior.clientId) =>
  selectRegisteredMobileClient(JSON.stringify(entries), client, reserved);
describe("server registered native client isolation", () => {
  test("selects the independent registration without returning another client", () => {
    expect(select([senior])).toEqual({ ok: true, registration: senior });
    expect(select([senior], "ai.unknown.app")).toEqual({ ok: false, code: "invalid_client" });
    expect(select([{ ...senior, enabled: false }])).toEqual({ ok: false, code: "invalid_client" });
    expect(selectRegisteredMobileClient(undefined, senior.clientId, reserved)).toEqual({
      ok: false,
      code: "invalid_client",
    });
  });
  test("rejects duplicate or reserved client, application and return identities", () => {
    for (const entry of [
      senior,
      { ...senior, clientId: reserved.clientId },
      { ...senior, appId: reserved.appId },
      { ...senior, redirectUri: reserved.redirectUri },
    ]) {
      expect(select(entry === senior ? [senior, senior] : [entry])).toEqual({
        ok: false,
        code: "server_configuration_error",
      });
    }
  });
  test("rejects ambiguous, insecure or credential-bearing redirect strings", () => {
    for (const redirectUri of [
      "http://cloud.eliza.app/callback",
      "https://user:pass@cloud.eliza.app/callback",
      "https://cloud.eliza.app/callback?next=1",
      "https://cloud.eliza.app/callback#token",
      "https://cloud.eliza.app/a/../callback",
      "not-a-url",
    ])
      expect(select([{ ...senior, redirectUri }])).toEqual({
        ok: false,
        code: "server_configuration_error",
      });
  });
  test("does not accept partial or wrongly typed configuration", () => {
    for (const entry of [
      { ...senior, enabled: "true" },
      { ...senior, appId: "bad" },
      { ...senior, scopes: ["admin"] },
      { ...senior, clientId: "__proto__" },
      null,
      [],
    ])
      expect(select([entry])).toEqual({ ok: false, code: "server_configuration_error" });
    expect(selectRegisteredMobileClient("{", senior.clientId, reserved)).toEqual({
      ok: false,
      code: "server_configuration_error",
    });
    expect(selectRegisteredMobileClient(" ".repeat(16385), senior.clientId, reserved)).toEqual({
      ok: false,
      code: "server_configuration_error",
    });
    expect(select({ [senior.clientId]: senior })).toEqual({
      ok: false,
      code: "server_configuration_error",
    });
  });
});
