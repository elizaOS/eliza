/**
 * Exercises Cloud membership admission and private wire validation with a controlled
 * transport. These unit contracts are not evidence of a live Network lookup.
 */

import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core/protocol";
import {
  type NetworkAppId,
  type NetworkMembershipAccount,
  NetworkMembershipClient,
  type NetworkMembershipFetcher,
  networkMembershipScopeId,
} from "./network-membership-client";
import { formatNetworkSharedTurnForModel } from "./network-shared-context";
import { sharedRuntimeConversationRoomId } from "./shared-runtime-storage-identity";

function account(): NetworkMembershipAccount {
  return {
    authenticatedUser: {
      id: "cloud-user",
      organization_id: "cloud-org",
      organization: { id: "cloud-org", is_active: true },
      is_active: true,
      is_anonymous: false,
    },
    user: {
      id: "cloud-user",
      organization_id: "cloud-org",
      is_active: true,
      is_anonymous: false,
      account_lifecycle_state: "active",
      account_deletion_request_id: null,
      auth_fenced_at: null,
      deleted_at: null,
      phone_number: "+12125550181",
      phone_verified: true,
    },
    organization: {
      id: "cloud-org",
      is_active: true,
      account_lifecycle_state: "active",
      account_deletion_request_id: null,
    },
  };
}

const membership = { app: "slop", personId: "network-person", memberId: "network-member" };

describe("Network membership Cloud boundary", () => {
  test("the actual model projection preserves approved facts and omits internal identity canaries", () => {
    const approvedFacet = "Complete approved facet ".repeat(600);
    const projection = formatNetworkSharedTurnForModel({
      membership: {
        cloudUserId: "PRIVATE_CLOUD_USER",
        organizationId: "PRIVATE_ORG",
        app: "slop",
        personId: "PRIVATE_PERSON",
        memberId: "PRIVATE_MEMBER",
        scopeId: networkMembershipScopeId({
          cloudUserId: "PRIVATE_CLOUD_USER",
          organizationId: "PRIVATE_ORG",
          app: "slop",
          personId: "PRIVATE_PERSON",
          memberId: "PRIVATE_MEMBER",
        }),
      },
      context: {
        app: "slop",
        memberId: "PRIVATE_MEMBER",
        firstName: "Fixture",
        city: "SF",
        state: "open",
        stateFrom: null,
        stateUntil: null,
        facets: [approvedFacet],
        activeItems: null,
      },
    });
    for (const privateId of [
      "PRIVATE_CLOUD_USER",
      "PRIVATE_ORG",
      "PRIVATE_PERSON",
      "PRIVATE_MEMBER",
      "PRIVATE_SCOPE",
    ])
      expect(projection).not.toContain(privateId);
    expect(projection).toContain(approvedFacet);
    expect(projection).toContain('"firstName":"Fixture"');
    const unavailable = formatNetworkSharedTurnForModel({
      status: "unavailable",
      cloudUserId: "PRIVATE_CLOUD_USER",
      organizationId: "PRIVATE_ORG",
      reason: "membership_unavailable",
    });
    expect(unavailable).toContain('"reason":"membership_unavailable"');
    expect(unavailable).not.toContain("PRIVATE_CLOUD_USER");
    expect(unavailable).not.toContain("PRIVATE_ORG");
  });

  test("checks phone-only eligibility before the private canonical routing owner receives complete text", async () => {
    const paths: string[] = [];
    const input = account();
    const completeMessage = "Complete message; no Cloud keyword routing. ".repeat(300);
    const client = new NetworkMembershipClient(
      {
        fetch: async (request) => {
          paths.push(new URL(request.url).pathname);
          if (request.url === "https://network.internal/agent/membership-status") {
            expect(request.method).toBe("POST");
            expect(request.headers.get("authorization")).toBe("Bearer server-secret");
            expect(request.headers.get("cache-control")).toBe("no-store");
            expect(request.redirect).toBe("error");
            expect(request.cache).toBe("no-store");
            expect(await request.json()).toEqual({ e164: "+12125550181" });
            input.user.phone_number = "+12125550182";
            return Response.json({ active: true });
          }
          expect(request.url).toBe("https://network.internal/agent/route");
          expect(request.redirect).toBe("error");
          expect(request.cache).toBe("no-store");
          expect(await request.json()).toEqual({ e164: "+12125550181", text: completeMessage });
          return Response.json({
            app: "peon",
            personId: "canonical-person",
            memberId: "canonical-member",
          });
        },
      },
      "server-secret",
    );
    expect(await client.resolveForText(input, completeMessage)).toMatchObject({
      app: "peon",
      personId: "canonical-person",
      memberId: "canonical-member",
    });
    expect(paths).toEqual(["/agent/membership-status", "/agent/route"]);
  });

  test("keeps non-member Personal text out of Network and refuses malformed eligibility", async () => {
    for (const reply of [
      false,
      null,
      {},
      { active: "true" },
      { active: true, memberId: "private" },
    ]) {
      const requests: unknown[] = [];
      const client = new NetworkMembershipClient(
        {
          fetch: async (request) => {
            requests.push({ url: request.url, body: await request.json() });
            return Response.json(reply === false ? { active: false } : reply);
          },
        },
        "server-secret",
      );
      try {
        if (reply === false)
          expect(await client.resolveForText(account(), "PRIVATE_PERSONAL_TEXT")).toBeNull();
        else
          await expect(
            client.resolveForText(account(), "PRIVATE_PERSONAL_TEXT"),
          ).rejects.toMatchObject({ code: "NETWORK_MEMBERSHIP_RESPONSE_INVALID" });
      } finally {
        expect(requests).toEqual([
          {
            url: "https://network.internal/agent/membership-status",
            body: { e164: "+12125550181" },
          },
        ]);
      }
    }
  });

  test("rejects oversized private response streams explicitly and cancels reading", async () => {
    let cancelled = false;
    const client = new NetworkMembershipClient(
      {
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      },
      "server-secret",
    );
    await expect(client.resolve(account(), "slop")).rejects.toMatchObject({
      code: "NETWORK_MEMBERSHIP_RESPONSE_TOO_LARGE",
    });
    expect(cancelled).toBe(true);
  });
  const denied: [string, (input: NetworkMembershipAccount) => void][] = [
    [
      "anonymous authentication",
      (a) => {
        a.authenticatedUser.is_anonymous = true;
      },
    ],
    [
      "missing authentication activity",
      (a) => {
        delete a.authenticatedUser.is_active;
      },
    ],
    [
      "inactive authentication",
      (a) => {
        a.authenticatedUser.is_active = false;
      },
    ],
    [
      "different user",
      (a) => {
        a.authenticatedUser.id = "other";
      },
    ],
    [
      "different auth organization",
      (a) => {
        a.authenticatedUser.organization_id = "other";
      },
    ],
    [
      "different hydrated organization",
      (a) => {
        a.authenticatedUser.organization = { id: "other", is_active: true };
      },
    ],
    [
      "missing hydrated organization",
      (a) => {
        a.authenticatedUser.organization = null;
      },
    ],
    [
      "inactive hydrated organization",
      (a) => {
        a.authenticatedUser.organization = { id: "cloud-org", is_active: false };
      },
    ],
    [
      "different user organization",
      (a) => {
        a.user.organization_id = "other";
      },
    ],
    [
      "anonymous user",
      (a) => {
        a.user.is_anonymous = true;
      },
    ],
    [
      "inactive user",
      (a) => {
        a.user.is_active = false;
      },
    ],
    [
      "recovering user",
      (a) => {
        a.user.account_lifecycle_state = "deletion_recovery";
      },
    ],
    [
      "pending user deletion",
      (a) => {
        a.user.account_deletion_request_id = "pending";
      },
    ],
    [
      "auth fenced user",
      (a) => {
        a.user.auth_fenced_at = new Date();
      },
    ],
    [
      "deleted user",
      (a) => {
        a.user.deleted_at = new Date();
      },
    ],
    [
      "inactive organization",
      (a) => {
        a.organization.is_active = false;
      },
    ],
    [
      "deleting organization",
      (a) => {
        a.organization.account_lifecycle_state = "deletion_irreversible";
      },
    ],
    [
      "pending organization deletion",
      (a) => {
        a.organization.account_deletion_request_id = "pending";
      },
    ],
    [
      "unverified phone",
      (a) => {
        a.user.phone_verified = false;
      },
    ],
    [
      "missing phone",
      (a) => {
        a.user.phone_number = null;
      },
    ],
    [
      "noncanonical phone",
      (a) => {
        a.user.phone_number = "2125550181";
      },
    ],
    [
      "invalid E164 number",
      (a) => {
        a.user.phone_number = "+100";
      },
    ],
    [
      "email identity",
      (a) => {
        a.user.phone_number = "person@example.com";
      },
    ],
  ];

  for (const [name, mutate] of denied) {
    test(`rejects ${name} before transport`, async () => {
      let calls = 0;
      const client = new NetworkMembershipClient(
        {
          fetch: async () => {
            calls++;
            return Response.json(membership);
          },
        },
        "server-secret",
      );
      const input = account();
      mutate(input);
      await expect(client.resolve(input, "slop")).rejects.toMatchObject({
        code: "NETWORK_MEMBERSHIP_ACCOUNT_INVALID",
      });
      expect(calls).toBe(0);
    });
  }

  test("requires a supported app and configured server credential", async () => {
    const fetcher = {
      fetch: async () => {
        throw new Error("must not dispatch");
      },
    };
    for (const credential of ["", "secret\nheader", " secret"]) {
      expect(() => new NetworkMembershipClient(fetcher, credential)).toThrow(ElizaError);
    }
    const client = new NetworkMembershipClient(fetcher, "server-secret");
    for (const app of ["canonical", "", "slop&app=friends", "https://evil.invalid"]) {
      await expect(client.resolve(account(), app as NetworkAppId)).rejects.toMatchObject({
        code: "NETWORK_MEMBERSHIP_APP_INVALID",
      });
    }
  });

  test("uses the fixed private URL, minimal body, server credential and no redirects/cache", async () => {
    const controller = new AbortController();
    let received: Request | undefined;
    const fetcher: NetworkMembershipFetcher = {
      fetch: async (request) => {
        received = request;
        expect(request.url).toBe("https://network.internal/agent/membership?app=slop");
        expect(request.method).toBe("POST");
        expect(request.headers.get("authorization")).toBe("Bearer server-secret");
        expect(request.headers.get("cache-control")).toBe("no-store");
        expect(request.cache).toBe("no-store");
        expect(request.redirect).toBe("error");
        expect(await request.json()).toEqual({ e164: "+12125550181" });
        return new Response(null, { status: 404 });
      },
    };
    expect(
      await new NetworkMembershipClient(fetcher, "server-secret").resolve(
        account(),
        "slop",
        controller.signal,
      ),
    ).toBeNull();
    controller.abort();
    expect(received?.signal.aborted).toBe(true);
  });

  test("keeps status failures explicit and private response bodies undisclosed", async () => {
    for (const status of [301, 302, 400, 401, 403, 409, 429, 500, 503]) {
      const client = new NetworkMembershipClient(
        { fetch: async () => new Response("PRIVATE_OWNER_BODY", { status }) },
        "server-secret",
      );
      await expect(client.resolve(account(), "slop")).rejects.toMatchObject({
        code: "NETWORK_MEMBERSHIP_LOOKUP_FAILED",
        context: { status },
      });
    }
  });

  test("rejects malformed, widened and cross-app responses", async () => {
    for (const body of [
      null,
      [],
      {},
      { ...membership, app: "friends" },
      { ...membership, personId: "" },
      { ...membership, memberId: "bad\nmember" },
      { ...membership, profile: "PRIVATE" },
    ]) {
      const client = new NetworkMembershipClient(
        { fetch: async () => Response.json(body) },
        "server-secret",
      );
      await expect(client.resolve(account(), "slop")).rejects.toMatchObject({
        code: "NETWORK_MEMBERSHIP_RESPONSE_INVALID",
      });
    }
    const malformed = new NetworkMembershipClient(
      { fetch: async () => new Response("PRIVATE_INVALID_JSON") },
      "server-secret",
    );
    await expect(malformed.resolve(account(), "slop")).rejects.toMatchObject({
      code: "NETWORK_MEMBERSHIP_RESPONSE_INVALID",
    });
  });

  test("sanitizes arbitrary transport error messages and causes", async () => {
    const client = new NetworkMembershipClient(
      {
        fetch: async () => {
          throw new Error("server-secret +12125550181");
        },
      },
      "server-secret",
    );
    try {
      await client.resolve(account(), "slop");
      throw new Error("expected lookup failure");
    } catch (error) {
      // error-policy:J1 assertions inspect the deliberate transport boundary failure.
      expect(error).toBeInstanceOf(ElizaError);
      expect(error).toMatchObject({ code: "NETWORK_MEMBERSHIP_TRANSPORT_FAILED" });
      expect(String(error)).not.toContain("server-secret");
      expect(error).not.toHaveProperty("cause");
    }
  });

  test("propagates cancellation before dispatch and during binding I/O", async () => {
    const controller = new AbortController();
    const reason = new Error("owned cancellation");
    let calls = 0;
    const client = new NetworkMembershipClient(
      {
        fetch: async (request) => {
          calls++;
          controller.abort(reason);
          request.signal.throwIfAborted();
          return Response.json(membership);
        },
      },
      "server-secret",
    );
    await expect(client.resolve(account(), "slop", controller.signal)).rejects.toBe(reason);
    await expect(client.resolve(account(), "slop", controller.signal)).rejects.toBe(reason);
    await expect(client.resolveForText(account(), "private", controller.signal)).rejects.toBe(
      reason,
    );
    expect(calls).toBe(1);
  });

  test("binds authorization identity to every app and account scope", async () => {
    let reply = { ...membership };
    const client = new NetworkMembershipClient(
      {
        fetch: async (request) =>
          Response.json({ ...reply, app: new URL(request.url).searchParams.get("app") }),
      },
      "server-secret",
    );
    const base = await client.resolve(account(), "slop");
    expect(base).toMatchObject({
      cloudUserId: "cloud-user",
      organizationId: "cloud-org",
      ...membership,
    });
    expect((await client.resolve(account(), "slop"))?.scopeId).toBe(base?.scopeId);
    expect((await client.resolve(account(), "friends"))?.scopeId).not.toBe(base?.scopeId);
    const other = account();
    other.user.id = other.authenticatedUser.id = "other-user";
    expect((await client.resolve(other, "slop"))?.scopeId).not.toBe(base?.scopeId);
    const otherOrg = account();
    otherOrg.organization.id =
      otherOrg.user.organization_id =
      otherOrg.authenticatedUser.organization_id =
        "other-org";
    otherOrg.authenticatedUser.organization = { id: "other-org", is_active: true };
    expect((await client.resolve(otherOrg, "slop"))?.scopeId).not.toBe(base?.scopeId);
    reply = { ...membership, personId: "other-person" };
    expect((await client.resolve(account(), "slop"))?.scopeId).not.toBe(base?.scopeId);
    reply = { ...membership, memberId: "other-member" };
    expect((await client.resolve(account(), "slop"))?.scopeId).not.toBe(base?.scopeId);
    expect(base?.scopeId).not.toBe(sharedRuntimeConversationRoomId("personal:cloud-user"));
  });

  test("snapshots trusted account scope before asynchronous transport", async () => {
    const input = account();
    const client = new NetworkMembershipClient(
      {
        fetch: async () => {
          input.user.id = "mutated-user";
          input.organization.id = "mutated-org";
          return Response.json(membership);
        },
      },
      "server-secret",
    );
    expect(await client.resolve(input, "slop")).toMatchObject({
      cloudUserId: "cloud-user",
      organizationId: "cloud-org",
    });
  });

  test("reads complete approved self-context through the same private credential boundary", async () => {
    const context = {
      app: "slop",
      memberId: membership.memberId,
      firstName: "Fixture",
      city: "San Francisco",
      state: "open",
      stateFrom: null,
      stateUntil: null,
      facets: ["approved fixture facet", "Complete approved context fact ".repeat(600)],
      activeItems: [{ kind: "offer", summary: "Approved complete fixture" }],
    };
    const paths: string[] = [];
    const client = new NetworkMembershipClient(
      {
        fetch: async (request) => {
          const path = new URL(request.url).pathname;
          paths.push(path);
          expect(request.headers.get("authorization")).toBe("Bearer server-secret");
          expect(request.redirect).toBe("error");
          expect(request.cache).toBe("no-store");
          expect(await request.json()).toEqual({ e164: "+12125550181" });
          return Response.json(path === "/agent/membership" ? membership : context);
        },
      },
      "server-secret",
    );
    const binding = await client.resolve(account(), "slop");
    expect(binding).not.toBeNull();
    if (!binding) throw new Error("Expected fixture membership");
    expect(await client.resolveContext(account(), binding)).toEqual(context);
    expect(paths).toEqual(["/agent/membership", "/agent/context"]);
  });

  test("rejects cross-member, cross-app and widened or malformed self-context", async () => {
    const context = {
      app: "slop",
      memberId: membership.memberId,
      firstName: "Fixture",
      city: "SF",
      state: "open",
      stateUntil: null,
      facets: [],
      activeItems: null,
    };
    let reply: unknown = membership;
    const client = new NetworkMembershipClient(
      { fetch: async () => Response.json(reply) },
      "server-secret",
    );
    const binding = await client.resolve(account(), "slop");
    if (!binding) throw new Error("Expected fixture membership");
    for (reply of [
      { ...context, memberId: "other-member" },
      { ...context, app: "friends" },
      { ...context, state: ["open"] },
      { ...context, facets: ["valid", null] },
      { ...context, activeItems: [{ kind: "offer", summary: "valid", hidden: "private" }] },
      { ...context, hidden: "private" },
    ]) {
      await expect(client.resolveContext(account(), binding)).rejects.toMatchObject({
        code: "NETWORK_CONTEXT_RESPONSE_INVALID",
      });
    }
    const other = account();
    other.user.id = other.authenticatedUser.id = "other-user";
    await expect(client.resolveContext(other, binding)).rejects.toMatchObject({
      code: "NETWORK_MEMBERSHIP_ACCOUNT_INVALID",
    });
  });

  test("keeps revoked self-context unavailable instead of reconstructing it from membership IDs", async () => {
    let available = true;
    const client = new NetworkMembershipClient(
      {
        fetch: async () =>
          available ? Response.json(membership) : new Response(null, { status: 404 }),
      },
      "server-secret",
    );
    const binding = await client.resolve(account(), "slop");
    if (!binding) throw new Error("Expected fixture membership");
    available = false;
    expect(await client.resolveContext(account(), binding)).toBeNull();
  });
});
