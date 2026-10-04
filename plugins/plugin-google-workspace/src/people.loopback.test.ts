/**
 * Google People contact lookup through the installed googleapis HTTP client
 * against a loopback provider, proving the canonical outbound resource path.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Auth } from "googleapis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GoogleApiClientFactory } from "./client-factory.js";
import { GooglePeopleClient } from "./people.js";
import type { GoogleAuthClient, GoogleCredentialResolver } from "./types.js";

class LoopbackCredentialResolver implements GoogleCredentialResolver {
  calls = 0;

  async getAuthClient(): Promise<GoogleAuthClient> {
    this.calls += 1;
    const auth = new Auth.OAuth2Client();
    auth.setCredentials({
      access_token: "loopback-google-token",
      expiry_date: Date.now() + 60 * 60 * 1000,
    });
    return auth;
  }
}

let server: Server;
let originalBase: string | undefined;
let paths: string[] = [];
const resolver = new LoopbackCredentialResolver();
let client: GooglePeopleClient;

beforeAll(async () => {
  originalBase = process.env.ELIZA_MOCK_GOOGLE_BASE;
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://loopback.invalid");
    paths.push(url.pathname);
    if (url.pathname === "/v1/people/canonical-contact") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          resourceName: "people/canonical-contact",
          names: [{ displayName: "Canonical Contact" }],
        })
      );
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: 404 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  process.env.ELIZA_MOCK_GOOGLE_BASE = `http://127.0.0.1:${address.port}/`;
  client = new GooglePeopleClient(new GoogleApiClientFactory(resolver));
});

afterAll(async () => {
  if (originalBase === undefined) delete process.env.ELIZA_MOCK_GOOGLE_BASE;
  else process.env.ELIZA_MOCK_GOOGLE_BASE = originalBase;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("Google People provider boundary", () => {
  it("sends canonical people resources to the real people.get HTTP path", async () => {
    paths = [];
    const result = await client.getContact({
      accountId: "owner-account",
      resourceName: "people/canonical-contact",
    });

    expect(result).toMatchObject({
      resourceName: "people/canonical-contact",
      displayName: "Canonical Contact",
      source: "contact",
    });
    expect(paths).toEqual(["/v1/people/canonical-contact"]);
  });

  it("rejects Other Contacts before auth resolution or outbound HTTP", async () => {
    paths = [];
    const authCalls = resolver.calls;

    await expect(
      client.getContact({
        accountId: "owner-account",
        resourceName: "otherContacts/interaction-only",
      })
    ).rejects.toMatchObject({ code: "GOOGLE_PEOPLE_RESOURCE_NAME_INVALID" });
    expect(resolver.calls).toBe(authCalls);
    expect(paths).toEqual([]);
  });
});

it("keeps explicit API worlds isolated while resolving each requested account", async () => {
  const accounts: string[] = [];
  const endpoints: string[] = [];
  const servers: Server[] = [];
  try {
    for (const name of ["first", "second"]) {
      const listener = createServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            resourceName: "people/canonical-contact",
            names: [{ displayName: name }],
          })
        );
      });
      servers.push(listener);
      await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
      const address = listener.address() as AddressInfo;
      endpoints.push(`http://127.0.0.1:${address.port}`);
    }
    const scopedResolver: GoogleCredentialResolver = {
      async getAuthClient(request) {
        accounts.push(request.accountId);
        return resolver.getAuthClient();
      },
    };
    const clients = endpoints.map(
      (endpoint) => new GooglePeopleClient(new GoogleApiClientFactory(scopedResolver, endpoint))
    );
    const results = await Promise.all(
      clients.map((value, index) =>
        value.getContact({
          accountId: `account-${index}`,
          resourceName: "people/canonical-contact",
        })
      )
    );
    expect(results.map((value) => value.displayName)).toEqual(["first", "second"]);
    expect(accounts.sort()).toEqual(["account-0", "account-1"]);
  } finally {
    await Promise.all(
      servers.map(
        (listener) =>
          new Promise<void>((resolve, reject) =>
            listener.close((error) => (error ? reject(error) : resolve()))
          )
      )
    );
  }
});
