/**
 * Unit coverage for the vault saved-login client contracts: request-path and
 * query construction, percent-encoding of user-controlled domain/username/
 * identifier values, HTTP verb + JSON-body selection, and response-field
 * projection. Transport stubbed; no live agent.
 */
import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import "./client-vault";

function stubbedClient<T>(response: T) {
  const client = new ElizaClient("http://agent.example:31337", "token");
  const fetch = vi.fn(async () => response);
  client.fetch = fetch as typeof client.fetch;
  return { client, fetch };
}

const savedLogin = {
  source: "in-house" as const,
  identifier: "login-1",
  domain: "example.com",
  username: "alice",
  title: "Example",
  updatedAt: 1735689600000,
};

describe("ElizaClient saved-login vault methods", () => {
  describe("listSavedLogins", () => {
    it("GETs /api/secrets/logins without a query string when no domain filter is given", async () => {
      const { client, fetch } = stubbedClient({
        ok: true,
        logins: [savedLogin],
        failures: [],
      });

      await expect(client.listSavedLogins()).resolves.toEqual({
        logins: [savedLogin],
        failures: [],
      });
      expect(fetch).toHaveBeenCalledWith("/api/secrets/logins");
    });

    it("appends the domain filter percent-encoded so reserved characters stay inside the query value", async () => {
      const { client, fetch } = stubbedClient({
        ok: true,
        logins: [],
        failures: [],
      });

      await client.listSavedLogins("example.com/path?q=1");

      expect(fetch).toHaveBeenCalledWith(
        "/api/secrets/logins?domain=example.com%2Fpath%3Fq%3D1",
      );
    });

    it("projects only logins and failures out of the response envelope", async () => {
      const { client } = stubbedClient({
        ok: true,
        logins: [savedLogin],
        failures: [{ source: "bitwarden", message: "locked" }],
        unexpectedExtra: "dropped",
      });

      await expect(client.listSavedLogins()).resolves.toEqual({
        logins: [savedLogin],
        failures: [{ source: "bitwarden", message: "locked" }],
      });
    });
  });

  describe("revealSavedLogin", () => {
    it("serializes source + identifier through URLSearchParams and returns the revealed login", async () => {
      const revealed = {
        source: "bitwarden" as const,
        identifier: "op://Vault/Item/Cred",
        username: "alice",
        password: "hunter2",
        domain: null,
      };
      const { client, fetch } = stubbedClient({
        ok: true,
        login: revealed,
      });

      await expect(
        client.revealSavedLogin("bitwarden", "op://Vault/Item/Cred"),
      ).resolves.toBe(revealed);
      expect(fetch).toHaveBeenCalledWith(
        "/api/secrets/logins/reveal?source=bitwarden&identifier=op%3A%2F%2FVault%2FItem%2FCred",
      );
    });

    it("form-encodes identifiers containing separators so they cannot split the query", async () => {
      const { client, fetch } = stubbedClient({
        ok: true,
        login: {
          source: "in-house",
          identifier: "a b&c=d",
          username: "alice",
          password: "hunter2",
          domain: null,
        },
      });

      await client.revealSavedLogin("in-house", "a b&c=d");

      expect(fetch).toHaveBeenCalledWith(
        "/api/secrets/logins/reveal?source=in-house&identifier=a+b%26c%3Dd",
      );
    });
  });

  describe("saveSavedLogin", () => {
    it("POSTs the login as a JSON body to /api/secrets/logins", async () => {
      const { client, fetch } = stubbedClient({ ok: true });
      const input = {
        domain: "example.com",
        username: "alice",
        password: "hunter2",
      };

      await expect(client.saveSavedLogin(input)).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledWith("/api/secrets/logins", {
        method: "POST",
        body: JSON.stringify(input),
      });
    });

    it("forwards optional otpSeed and notes in the saved payload", async () => {
      const { client, fetch } = stubbedClient({ ok: true });
      const input = {
        domain: "example.com",
        username: "alice",
        password: "hunter2",
        otpSeed: "JBSWY3DPEHPK3PXP",
        notes: "work account",
      };

      await client.saveSavedLogin(input);

      expect(fetch).toHaveBeenCalledWith("/api/secrets/logins", {
        method: "POST",
        body: JSON.stringify(input),
      });
    });
  });

  describe("deleteSavedLogin", () => {
    it("DELETEs the domain/username pair with each segment percent-encoded", async () => {
      const { client, fetch } = stubbedClient({ ok: true });

      await expect(
        client.deleteSavedLogin("example.com", "alice@example.com"),
      ).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledWith(
        "/api/secrets/logins/example.com/alice%40example.com",
        { method: "DELETE" },
      );
    });

    it("keeps a username containing a slash inside one path segment", async () => {
      const { client, fetch } = stubbedClient({ ok: true });

      await client.deleteSavedLogin("example.com", "org/alice");

      expect(fetch).toHaveBeenCalledWith(
        "/api/secrets/logins/example.com/org%2Falice",
        { method: "DELETE" },
      );
    });
  });

  describe("autofill allowance", () => {
    it("GETs the autoallow endpoint and projects the allowed flag (true)", async () => {
      const { client, fetch } = stubbedClient({ ok: true, allowed: true });

      await expect(client.getAutofillAllowed("app.example.com")).resolves.toBe(
        true,
      );
      expect(fetch).toHaveBeenCalledWith(
        "/api/secrets/logins/app.example.com/autoallow",
      );
    });

    it("projects the allowed flag through unchanged when the server says false", async () => {
      const { client } = stubbedClient({ ok: true, allowed: false });

      await expect(client.getAutofillAllowed("app.example.com")).resolves.toBe(
        false,
      );
    });

    it("PUTs allowed=true as a JSON body", async () => {
      const { client, fetch } = stubbedClient({ ok: true });

      await client.setAutofillAllowed("app.example.com", true);

      expect(fetch).toHaveBeenCalledWith(
        "/api/secrets/logins/app.example.com/autoallow",
        { method: "PUT", body: JSON.stringify({ allowed: true }) },
      );
    });

    it("PUTs allowed=false rather than hardcoding an enable", async () => {
      const { client, fetch } = stubbedClient({ ok: true });

      await client.setAutofillAllowed("app.example.com", false);

      expect(fetch).toHaveBeenCalledWith(
        "/api/secrets/logins/app.example.com/autoallow",
        { method: "PUT", body: JSON.stringify({ allowed: false }) },
      );
    });
  });
});
