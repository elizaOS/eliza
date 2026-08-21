/**
 * Contract tests for `GooglePeopleClient` and the `people.read` capability:
 * page-based listing with opaque token replay, dual-source search (contacts +
 * Other Contacts) with the documented warmup request, canonical resource-name
 * enforcement, malformed-upstream rejection, auth failure propagation, and scope derivation. Deterministic
 * harness — the googleapis People surface is replaced with protocol-faithful
 * fakes; no network access.
 */
import { describe, expect, it, vi } from "vitest";
import type { GoogleApiClientFactory } from "./client-factory.js";
import { GooglePeopleClient } from "./people.js";
import {
  GOOGLE_CAPABILITY_METADATA,
  GOOGLE_OAUTH_SCOPES,
  scopesForGoogleCapabilities,
} from "./scopes.js";

interface PeopleApiFakes {
  connectionsList?: ReturnType<typeof vi.fn>;
  searchContacts?: ReturnType<typeof vi.fn>;
  otherContactsSearch?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
}

function clientFor(fakes: PeopleApiFakes): {
  client: GooglePeopleClient;
  peopleFactory: ReturnType<typeof vi.fn>;
} {
  const peopleFactory = vi.fn(async () => ({
    people: {
      connections: { list: fakes.connectionsList ?? vi.fn() },
      searchContacts: fakes.searchContacts ?? vi.fn(async () => ({ data: {} })),
      get: fakes.get ?? vi.fn(),
    },
    otherContacts: {
      search: fakes.otherContactsSearch ?? vi.fn(async () => ({ data: {} })),
    },
  }));
  const factory = { people: peopleFactory } as unknown as GoogleApiClientFactory;
  return { client: new GooglePeopleClient(factory), peopleFactory };
}

const RICH_PERSON = {
  resourceName: "people/c1",
  names: [
    { displayName: "Secondary Name", givenName: "Secondary" },
    {
      displayName: "Ada Lovelace",
      givenName: "Ada",
      familyName: "Lovelace",
      metadata: { primary: true },
    },
  ],
  emailAddresses: [
    { value: "ada@example.com", type: "work", metadata: { primary: true } },
    { value: null },
  ],
  phoneNumbers: [{ value: "+1 555 0100", type: "mobile" }],
  organizations: [{ name: "Analytical Engines", title: "Countess" }, {}],
  photos: [{ url: "https://example.com/ada.jpg" }],
};

describe("people.read capability catalog", () => {
  it("derives contacts and other-contacts read scopes for people.read", () => {
    const scopes = scopesForGoogleCapabilities(["people.read"], {
      includeIdentityScopes: false,
    });
    expect(scopes).toEqual([GOOGLE_OAUTH_SCOPES.people.read, GOOGLE_OAUTH_SCOPES.people.otherRead]);
    expect(GOOGLE_CAPABILITY_METADATA["people.read"].group).toBe("people");
  });
});

describe("listContacts", () => {
  it("maps a full person record and reports the primary name and clean collections", async () => {
    const connectionsList = vi.fn(async () => ({
      data: { connections: [RICH_PERSON], nextPageToken: "next-1" },
    }));
    const { client, peopleFactory } = clientFor({ connectionsList });

    const page = await client.listContacts({ accountId: "acct-1" });

    expect(page).toEqual({
      contacts: [
        {
          resourceName: "people/c1",
          displayName: "Ada Lovelace",
          givenName: "Ada",
          familyName: "Lovelace",
          emailAddresses: [{ value: "ada@example.com", type: "work", primary: true }],
          phoneNumbers: [{ value: "+1 555 0100", type: "mobile", primary: undefined }],
          organizations: [{ name: "Analytical Engines", title: "Countess" }],
          photoUrl: "https://example.com/ada.jpg",
          source: "contact",
        },
      ],
      nextPageToken: "next-1",
    });
    expect(peopleFactory).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct-1" }),
      ["people.read"],
      "people.listContacts"
    );
  });

  it("returns a designed-empty page with a null cursor when the account has no contacts", async () => {
    const connectionsList = vi.fn(async () => ({ data: {} }));
    const { client } = clientFor({ connectionsList });

    await expect(client.listContacts({ accountId: "acct-1" })).resolves.toEqual({
      contacts: [],
      nextPageToken: null,
    });
  });

  it("replays an opaque page token without rewriting it", async () => {
    const opaqueToken = "  opaque token  ";
    const connectionsList = vi.fn(async () => ({ data: { connections: [] } }));
    const { client } = clientFor({ connectionsList });

    await client.listContacts({ accountId: "acct-1", pageToken: opaqueToken });

    expect(connectionsList).toHaveBeenCalledWith(
      expect.objectContaining({ pageToken: opaqueToken })
    );
  });

  it("rejects a person record without a resourceName instead of fabricating a contact", async () => {
    const connectionsList = vi.fn(async () => ({
      data: { connections: [{ names: [{ displayName: "Ghost" }] }] },
    }));
    const { client } = clientFor({ connectionsList });

    await expect(client.listContacts({ accountId: "acct-1" })).rejects.toMatchObject({
      code: "GOOGLE_PEOPLE_MALFORMED_PERSON",
    });
  });

  it("propagates auth resolution failures from the client factory", async () => {
    const factory = {
      people: vi.fn(async () => {
        throw new Error("invalid_grant");
      }),
    } as unknown as GoogleApiClientFactory;
    const client = new GooglePeopleClient(factory);

    await expect(client.listContacts({ accountId: "acct-1" })).rejects.toThrow("invalid_grant");
  });
});

describe("searchContacts", () => {
  it("rejects an empty query before touching the API", async () => {
    const searchContacts = vi.fn();
    const { client, peopleFactory } = clientFor({ searchContacts });

    await expect(
      client.searchContacts({ accountId: "acct-1", query: "   " })
    ).rejects.toMatchObject({ code: "GOOGLE_PEOPLE_SEARCH_QUERY_EMPTY" });
    expect(peopleFactory).not.toHaveBeenCalled();
  });

  it("issues the warmup request before the real query for both sources", async () => {
    const searchContacts = vi.fn(async () => ({ data: { results: [] } }));
    const otherContactsSearch = vi.fn(async () => ({ data: { results: [] } }));
    const { client } = clientFor({ searchContacts, otherContactsSearch });

    await client.searchContacts({ accountId: "acct-1", query: "ada" });

    expect(searchContacts).toHaveBeenCalledTimes(2);
    expect(searchContacts.mock.calls[0][0]).toMatchObject({ query: "" });
    expect(searchContacts.mock.calls[1][0]).toMatchObject({ query: "ada" });
    expect(otherContactsSearch).toHaveBeenCalledTimes(2);
    expect(otherContactsSearch.mock.calls[0][0]).toMatchObject({ query: "" });
    expect(otherContactsSearch.mock.calls[1][0]).toMatchObject({ query: "ada" });
  });

  it("merges saved contacts and Other Contacts with per-source tags", async () => {
    const searchContacts = vi.fn(async (params: { query: string }) => ({
      data: {
        results:
          params.query === ""
            ? []
            : [{ person: { resourceName: "people/c1", names: [{ displayName: "Ada" }] } }],
      },
    }));
    const otherContactsSearch = vi.fn(async (params: { query: string }) => ({
      data: {
        results:
          params.query === ""
            ? []
            : [
                {
                  person: {
                    resourceName: "otherContacts/o1",
                    emailAddresses: [{ value: "other@example.com" }],
                  },
                },
              ],
      },
    }));
    const { client } = clientFor({ searchContacts, otherContactsSearch });

    const results = await client.searchContacts({ accountId: "acct-1", query: "a" });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ resourceName: "people/c1", source: "contact" });
    expect(results[1]).toMatchObject({
      resourceName: "otherContacts/o1",
      displayName: "other@example.com",
      source: "otherContact",
    });
  });

  it("skips Other Contacts when includeOtherContacts is false", async () => {
    const searchContacts = vi.fn(async () => ({ data: { results: [] } }));
    const otherContactsSearch = vi.fn();
    const { client } = clientFor({ searchContacts, otherContactsSearch });

    await client.searchContacts({
      accountId: "acct-1",
      query: "ada",
      includeOtherContacts: false,
    });

    expect(otherContactsSearch).not.toHaveBeenCalled();
  });

  it("clamps the requested page size to the People API search maximum of 30", async () => {
    const searchContacts = vi.fn(async () => ({ data: { results: [] } }));
    const { client } = clientFor({ searchContacts });

    await client.searchContacts({
      accountId: "acct-1",
      query: "ada",
      maxResults: 500,
      includeOtherContacts: false,
    });

    expect(searchContacts.mock.calls[1][0]).toMatchObject({ pageSize: 30 });
  });
});

describe("getContact", () => {
  it("fetches one contact by resource name with the people.read capability", async () => {
    const get = vi.fn(async () => ({ data: RICH_PERSON }));
    const { client, peopleFactory } = clientFor({ get });

    const contact = await client.getContact({ accountId: "acct-1", resourceName: "people/c1" });

    expect(contact).toMatchObject({ resourceName: "people/c1", source: "contact" });
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ resourceName: "people/c1" }));
    expect(peopleFactory).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct-1" }),
      ["people.read"],
      "people.getContact"
    );
  });

  it.each(["", "   ", "otherContacts/o9", "people/", "people/c1/extra", "contact-c1"])(
    "rejects non-canonical resource name %j before credential or API work",
    async (resourceName) => {
      const get = vi.fn();
      const { client, peopleFactory } = clientFor({ get });

      await expect(client.getContact({ accountId: "acct-1", resourceName })).rejects.toMatchObject({
        code: "GOOGLE_PEOPLE_RESOURCE_NAME_INVALID",
      });
      expect(peopleFactory).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    }
  );
});
