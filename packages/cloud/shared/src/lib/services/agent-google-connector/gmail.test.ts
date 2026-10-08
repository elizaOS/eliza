import { afterEach, expect, spyOn, test } from "bun:test";
import { fetchManagedGoogleGmailSearch, normalizeManagedGmailBodyText } from "./gmail";
import * as shared from "./shared";

const input = {
  organizationId: "org-a",
  userId: "user-a",
  side: "owner" as const,
  grantId: "grant-a",
  query: "from:bill@example.org",
  maxResults: 2,
};
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
function setup(list: unknown, partial = false) {
  spies.push(
    spyOn(shared, "getManagedGoogleConnectorStatus").mockResolvedValue({
      identity: { email: "person@example.org" },
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    } as shared.ManagedGoogleConnectorStatus),
  );
  const calls: Array<Parameters<typeof shared.googleFetch>[0]> = [];
  spies.push(
    spyOn(shared, "googleFetch").mockImplementation(async (args) => {
      calls.push(args);
      if (new URL(args.url).pathname.endsWith("/messages")) return Response.json(list);
      return Response.json({
        id: partial ? "different" : "m1",
        threadId: "t1",
        internalDate: "1756684800000",
        payload: { headers: [{ name: "From", value: "bill@example.org" }] },
      });
    }),
  );
  return calls;
}
test("managed Gmail search preserves opaque continuation and grant scope", async () => {
  const calls = setup({ messages: [{ id: "m1" }], nextPageToken: "next+/opaque=" });
  const result = await fetchManagedGoogleGmailSearch({ ...input, pageToken: "previous+/opaque=" });
  expect(result.nextPageToken).toBe("next+/opaque=");
  expect(result.messages[0].htmlLink).toBe(
    "https://mail.google.com/mail/u/person%40example.org/#all/t1",
  );
  expect(result.messages.map((message) => message.externalId)).toEqual(["m1"]);
  expect(new URL(calls[0].url).searchParams.get("pageToken")).toBe("previous+/opaque=");
  expect(
    calls.every(
      (call) =>
        call.organizationId === input.organizationId &&
        call.userId === input.userId &&
        call.grantId === input.grantId,
    ),
  ).toBe(true);
});
test("an empty intermediate Gmail page retains its continuation", async () => {
  setup({ nextPageToken: "next" });
  expect(await fetchManagedGoogleGmailSearch(input)).toMatchObject({
    messages: [],
    nextPageToken: "next",
  });
});
test("the final Gmail page explicitly has no continuation", async () => {
  setup({ messages: [] });
  expect(await fetchManagedGoogleGmailSearch(input)).toMatchObject({
    messages: [],
    nextPageToken: null,
  });
});
test("malformed or oversized pages cannot silently become complete search results", async () => {
  for (const list of [
    { messages: {} },
    { messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] },
    { messages: [], nextPageToken: 42 },
    { messages: [{}] },
  ]) {
    setup(list);
    await expect(fetchManagedGoogleGmailSearch(input)).rejects.toBeInstanceOf(
      shared.AgentGoogleConnectorError,
    );
    for (const spy of spies.splice(0)) spy.mockRestore();
  }
  setup({ messages: [{ id: "m1" }] }, true);
  await expect(fetchManagedGoogleGmailSearch(input)).rejects.toBeInstanceOf(
    shared.AgentGoogleConnectorError,
  );
});

test("managed search never substitutes mailbox zero for missing Google identity", async () => {
  setup({ messages: [{ id: "m1" }] });
  spies.push(
    spyOn(shared, "getManagedGoogleConnectorStatus").mockResolvedValue({
      identity: null,
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    } as shared.ManagedGoogleConnectorStatus),
  );
  expect((await fetchManagedGoogleGmailSearch(input)).messages[0].htmlLink).toBeNull();
});

test("HTML mail decodes a hexadecimal apostrophe entity", () => {
  expect(normalizeManagedGmailBodyText("<p>It&#x27;s due</p>")).toBe("It's due");
  expect(normalizeManagedGmailBodyText("<p>It&#39;s due</p>")).toBe("It's due");
});
