/** Route component proof: real Hono handlers, entitlement room resolver, and coordinator envelopes; no inference. */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { svcSign } from "@elizaos/plugin-network/svc-auth";
import { networkMembershipScopeId } from "../../shared/src/lib/services/shared-runtime/network-membership-client";
import { personalSharedAgentId } from "../../shared/src/lib/services/shared-runtime/personal-shared-identity";

// Authentication and entitlement reads are controlled fixtures. Route parsing,
// Personal room authorization, context downgrading, and DO dispatch stay real.
const boundaries: Record<string, string> = {
  "db/repositories/users.ts": `export const usersRepository = { async findByPhoneNumberWithOrganization() { return globalThis.__roomRouteFixture.nativePrimary ?? null; } };`,
  "lib/api/errors.ts": `
    export class ApiError extends Error {}
    export class ValidationError extends Error {}
    export class InsufficientCreditsError extends Error {}
    export class RateLimitError extends Error {}
    export function errorToResponse(error) { return Response.json({ error: error.message }, { status: 500 }); }
  `,
  "lib/auth.ts": `export async function requireAuthOrApiKeyWithOrg() { throw new Error("unexpected Dedicated auth"); }`,
  "lib/auth/cron.ts": `export function timingSafeEqualSecret(a, b) { return a === b; }`,
  "lib/cache/client.ts": `export const cache = { get() { throw new Error("unexpected voice cache"); } };`,
  "lib/services/eliza-app/index.ts": `export const elizaAppUserService = new Proxy({}, { get() { throw new Error("unexpected native account side effect"); } });`,
  "lib/services/eliza-sandbox.ts": `export const elizaSandboxService = { bridge() { throw new Error("unexpected Dedicated dispatch"); } };`,
  "lib/services/agent-tier-upgrade-target.ts": `export async function findActivePersonalDedicatedTarget() { return globalThis.__roomRouteFixture.dedicated ? { id: "dedicated-fixture" } : null; }`,
  "lib/services/personal-dedicated-fallback.ts": `
    export async function resolvePersonalDedicatedRoute() { return globalThis.__roomRouteFixture.fallback; }
    export async function resolvePersonalDedicatedTrafficAccess() { throw new Error("unexpected direct Dedicated access"); }
  `,
  "lib/services/personal-dedicated-fallback-reconcile.ts": `export async function reconcilePersonalFallbackIntoDedicated() { throw new Error("unexpected reconciliation"); }`,
  "lib/services/shared-runtime/resolve-shared-agent.ts": `
    export async function resolveSharedAgent() { const { agent } = globalThis.__roomRouteFixture; return { agent, agentId: agent.id, orgId: agent.organization_id, agentName: "Eliza", agentKind: "personal" }; }
    export function resolveSharedRuntimeWorkerRequestContext() { return globalThis.__roomRouteFixture.worker; }
  `,
  "lib/services/shared-runtime/network-shared-turn.ts": `export async function prepareNetworkSharedTurn() { return globalThis.__roomRouteFixture.network; } export async function prepareNetworkSharedTurnForAccount() { globalThis.__roomRouteFixture.nativeEffects.service++; throw new Error("unexpected native Network read"); }`,
  "lib/services/shared-runtime/prewarm-shared-agent.ts": `export async function prewarmPersonalSharedAgentTurnCaches() { globalThis.__roomRouteFixture.nativeEffects.prewarm++; }`,
  "lib/services/personal-dedicated-delivery.ts": `export async function preparePersonalDedicatedDelivery() { globalThis.__roomRouteFixture.nativeEffects.bridge++; throw new Error("unexpected native Dedicated preparation"); }`,
  "lib/services/shared-runtime/shared-runtime-chat.ts": `
    export { sharedTurnClientMessageId } from "./shared-turn-client-message-id";
    export { normalizeSharedRuntimeRoom } from "./shared-runtime-room-identity";
    export const sharedRuntimeChatService = {};
  `,
  "lib/services/shared-runtime/shared-turn-observability.ts": `
    export async function classifyBridgeRequestMethod() { return "message.send"; }
    export async function classifySharedTurnOutcome() { return "success"; }
    export function recordSharedTurnAttempt() {}
  `,
  "lib/utils/logger.ts": `export const logger = { debug() {}, info() {}, warn() {}, error() {} };`,
};

test("Network enrichment preserves selected rooms across the four Personal HTTP surfaces", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "network-personal-room-routes-"),
  );
  const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
  const sourceDirectory = fileURLToPath(
    new URL("../../shared/src/", import.meta.url),
  );
  try {
    const entry = join(directory, "entry.ts");
    const agentRoutes = join(apiDirectory, "v1/eliza/agents/[agentId]");
    await Bun.write(
      entry,
      `
      import { Hono } from ${JSON.stringify(fileURLToPath(import.meta.resolve("hono")))};
      import bridge from ${JSON.stringify(join(agentRoutes, "bridge/route.ts"))};
      import stream from ${JSON.stringify(join(agentRoutes, "stream/route.ts"))};
      import rest from ${JSON.stringify(join(agentRoutes, "api/conversations/[conversationId]/messages/route.ts"))};
      import canonical from ${JSON.stringify(join(agentRoutes, "api/conversations/[conversationId]/messages/stream/route.ts"))};
      import native from ${JSON.stringify(join(apiDirectory, "internal/eliza-app/personal-shared/messages/route.ts"))};
      export function configure(fixture) { globalThis.__roomRouteFixture = fixture; }
      export const app = new Hono()
        .route("/api/internal/eliza-app/personal-shared/messages", native)
        .route("/:agentId/bridge", bridge)
        .route("/:agentId/stream", stream)
        .route("/:agentId/api/conversations/:conversationId/messages", rest)
        .route("/:agentId/api/conversations/:conversationId/messages/stream", canonical);
    `,
    );
    const build = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      format: "esm",
      conditions: ["eliza-source"],
      plugins: [
        {
          name: "room-route-external-boundaries",
          setup(builder) {
            // Match the Worker alias: SSH runs on the sidecar, never in these routes.
            builder.onResolve({ filter: /^ssh2$/ }, () => ({
              path: join(apiDirectory, "src/stubs/ssh2.ts"),
            }));
            builder.onResolve({ filter: /^@elizaos\/core$/ }, () => ({
              path: fileURLToPath(import.meta.resolve("@elizaos/core")),
              external: true,
            }));
            builder.onResolve(
              { filter: /^@\/(?:db|lib|types)\// },
              ({ path }) => ({
                path: join(sourceDirectory, `${path.slice(2)}.ts`),
              }),
            );
            builder.onLoad({ filter: /_local-dedicated-proxy\.ts$/ }, () => ({
              loader: "ts",
              contents:
                "export async function proxyLocalDedicatedOrNext(_c, next) { return next(); }",
            }));
            builder.onLoad(
              { filter: /voice-agent-scope-hydration\.ts$/ },
              () => ({
                loader: "ts",
                contents:
                  'export async function hydrateVoiceSharedAgentScope() { throw new Error("unexpected voice hydration"); }',
              }),
            );
            builder.onLoad(
              { filter: /personal-delivery-projection\.ts$/ },
              () => ({
                loader: "ts",
                contents:
                  'export class PersonalDeliveryAccountResolutionError extends Error {} export async function resolvePersonalDeliveryProjection() { globalThis.__roomRouteFixture.nativeEffects.projection++; const a = globalThis.__roomRouteFixture.nativeAccount; if (a?.isNew) globalThis.__roomRouteFixture.nativeEffects.identityCreate++; if (!a) throw new Error("unexpected native account resolution"); return a; }',
              }),
            );
            builder.onLoad({ filter: /internal\/_auth\.ts$/ }, () => ({
              loader: "ts",
              contents:
                'export async function requireInternalAuth() { return { service: "webhook-gateway" }; }',
            }));
            for (const [suffix, contents] of Object.entries(boundaries)) {
              builder.onLoad(
                { filter: new RegExp(`${suffix.replaceAll(".", "\\.")}$`) },
                () => ({ loader: "ts", contents }),
              );
            }
          },
        },
      ],
    });
    expect(build.success, build.logs.map(String).join("\n")).toBe(true);
    const output = join(directory, "routes.mjs");
    await Bun.write(output, await build.outputs[0].text());
    expect(await Bun.file(output).exists()).toBe(true);
    const { app, configure } = await import(
      `data:text/javascript;base64,${Buffer.from(await Bun.file(output).text()).toString("base64")}`
    );
    const agent = {
      id: personalSharedAgentId({
        userId: "room-user",
        organizationId: "room-org",
      }),
      user_id: "room-user",
      organization_id: "room-org",
      execution_tier: "shared",
    };
    const membership = {
      app: "slop" as const,
      cloudUserId: agent.user_id,
      organizationId: agent.organization_id,
      personId: "room-person",
      memberId: "room-member",
    };
    const network = {
      membership: {
        ...membership,
        scopeId: networkMembershipScopeId(membership),
      },
      context: {
        app: "slop",
        memberId: membership.memberId,
        firstName: "Fixture",
        city: "SF",
        state: "open",
        stateUntil: null,
        facets: [],
        activeItems: null,
      },
    };
    type TurnEnvelope = {
      operation: string;
      rpc: { id?: string; params: { roomId: string; userId?: string } };
      trustedNetworkContext: unknown;
    };
    const bodies: TurnEnvelope[] = [];
    const names: string[] = [];
    const namespace = {
      getByName(name: string) {
        names.push(name);
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const body = (await new Request(
              input,
              init,
            ).json()) as TurnEnvelope;
            bodies.push(body);
            if (body.operation === "network-delivery")
              return Response.json({
                ok: true,
                providerMessageIds: ["fixture-receipt"],
                history: true,
              });
            return body.operation.endsWith("stream")
              ? new Response("event: done\ndata: {}\n\n", {
                  headers: { "Content-Type": "text/event-stream" },
                })
              : Response.json({
                  jsonrpc: "2.0",
                  id: body.rpc.id,
                  result: { text: "coordinated" },
                });
          },
        };
      },
    };
    const fixture = {
      agent,
      network: network as unknown,
      worker: { namespace, executionCtx: { waitUntil() {} } },
      dedicated: false,
      fallback: undefined as unknown,
    };
    configure(fixture);
    async function send(surface: string, room?: string) {
      bodies.length = 0;
      names.length = 0;
      const direct = surface === "bridge" || surface === "stream";
      const path = direct
        ? surface
        : `api/conversations/${encodeURIComponent(room ?? agent.id)}/messages${surface === "canonical" ? "/stream" : ""}`;
      const body = direct
        ? {
            jsonrpc: "2.0",
            method: "message.send",
            params: {
              text: "hello",
              ...(room === undefined ? {} : { roomId: room }),
              userId: "forged-user",
            },
          }
        : { text: "hello" };
      const response = await app.request(
        `https://room.test/${agent.id}/${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      await response.text();
      return response;
    }
    for (const surface of ["bridge", "stream", "rest", "canonical"]) {
      for (const room of [
        agent.id,
        `  ${agent.id}  `,
        "other-room",
        "default",
      ]) {
        expect((await send(surface, room)).status).toBe(200);
        expect(bodies).toHaveLength(1);
        expect(bodies[0].rpc.params.roomId.trim()).toBe(room.trim());
        expect(names).toEqual([`${agent.id}:${room.trim()}`]);
        expect(bodies[0].trustedNetworkContext).toEqual(
          room.trim() === agent.id
            ? network
            : {
                status: "unavailable",
                cloudUserId: agent.user_id,
                organizationId: agent.organization_id,
                reason: "personal_fallback",
              },
        );
        if (surface !== "canonical")
          expect(bodies[0].rpc.params.userId).toBe(agent.user_id);
      }
      if (surface === "bridge" || surface === "stream") {
        for (const room of [undefined, "", "  "]) {
          expect((await send(surface, room)).status).toBe(200);
          expect(bodies[0].rpc.params.roomId).toBe(agent.id);
          expect(bodies[0].trustedNetworkContext).toEqual(network);
        }
      }
      // Context availability cannot change the selected conversation. Literal
      // "default" is an explicit existing label; only absent/blank input defaults
      // to the Personal canonical room.
      for (const observation of [
        undefined,
        {
          status: "unavailable",
          cloudUserId: agent.user_id,
          organizationId: agent.organization_id,
          reason: "configuration_unavailable",
        },
      ]) {
        fixture.network = observation;
        for (const room of [agent.id, "other-room", "default", undefined]) {
          expect((await send(surface, room)).status).toBe(200);
          expect(bodies[0].rpc.params.roomId).toBe(room ?? agent.id);
          expect(names).toEqual([`${agent.id}:${room ?? agent.id}`]);
          expect(bodies[0].trustedNetworkContext).toEqual(
            !observation || !room || room === agent.id
              ? observation
              : { ...observation, reason: "personal_fallback" },
          );
        }
      }
      fixture.network = network;
      fixture.dedicated = true;
      fixture.fallback = {
        route: "shared_fallback",
        delivery: {
          journalRoomId: "fallback:owned-journal",
          accountState: { access: "shared_fallback" },
          fallback: {},
        },
      };
      for (const room of [agent.id, "fallback:owned-journal"]) {
        expect((await send(surface, room)).status).toBe(200);
        expect(bodies[0].rpc.params.roomId).toBe("fallback:owned-journal");
        expect(bodies[0].trustedNetworkContext).toMatchObject({
          reason: "personal_fallback",
        });
      }
      expect((await send(surface, "foreign-fallback-room")).status).toBe(404);
      expect(bodies).toHaveLength(0);
      expect(names).toHaveLength(0);
      fixture.fallback = { route: "dedicated" };
      expect((await send(surface, agent.id)).status).toBe(409);
      expect(bodies).toHaveLength(0);
      fixture.dedicated = false;
    }
    Object.assign(fixture, {
      nativeEffects: {
        prewarm: 0,
        bridge: 0,
        service: 0,
        projection: 0,
        identityCreate: 0,
      },
    });
    // Controlled service auth; actual native schema/HMAC/policy rejects before account/DO work.
    const secret = "synthetic-native-admission-secret-0123456789abcdef";
    const policy = {
      project: "eliza-app",
      platform: "blooio",
      phoneNumber: "+12125550112",
      connectorAccountId: "+12125550111",
      messageIdPrefix: "blooio:eliza-app:",
      userId: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000002",
    };
    for (const invalid of [
      "signature",
      "connector",
      "array-user-id",
      "transport",
    ] as const) {
      bodies.length = 0;
      names.length = 0;
      const wire = {
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId:
          invalid === "connector" ? "+12125550999" : policy.connectorAccountId,
        phoneNumber: policy.phoneNumber,
        messageId: "blooio:eliza-app:synthetic-native",
        message: "Synthetic profile",
        transport: invalid === "transport" ? "not-a-transport" : "sms",
        networkTurn: {
          channel: "blooio",
          app: "slop",
          memberId: "synthetic-member",
          messageId: "synthetic-native",
          context: {
            firstName: "Alex",
            city: "sf",
            state: "open",
            stateFrom: null,
            stateUntil: null,
            facets: [],
            activeItems: [],
            singlePlayer: false,
          },
        },
      };
      const raw = JSON.stringify(wire),
        path = "/api/internal/eliza-app/personal-shared/messages";
      const signed = await svcSign(secret, {
        method: "POST",
        path,
        id: "synthetic-native",
        body: raw,
      });
      if (invalid === "signature") signed["x-ntwrk-svc-sig"] = "0".repeat(64);
      const selectedPolicy =
        invalid === "array-user-id"
          ? { ...policy, userId: [policy.userId] }
          : policy;
      const response = await app.fetch(
        new Request("http://route-fixture.test" + path, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...signed },
          body: raw,
        }),
        {
          NETWORK_PERSONAL_CONTINUITY_ENABLED: "true",
          NETWORK_OWNED_INGRESS_POLICY: JSON.stringify(selectedPolicy),
          SERVICE_TURN_SECRET: secret,
        },
      );
      expect(response.status).toBe(invalid === "transport" ? 400 : 403);
      expect(bodies).toHaveLength(0);
      expect(names).toHaveLength(0);
    }
    for (const outcome of ["open", "handled"] as const)
      for (const refusal of [
        "policy-account-mismatch",
        "unknown-primary",
        "dedicated-owned",
      ] as const) {
        Object.assign(fixture, {
          nativeAccount: {
            userId:
              refusal === "policy-account-mismatch"
                ? "00000000-0000-4000-8000-000000000099"
                : policy.userId,
            organizationId: policy.organizationId,
            isNew: false,
            dedicatedTarget:
              refusal === "dedicated-owned"
                ? { id: "dedicated-fixture" }
                : null,
          },
          nativeEffects: {
            prewarm: 0,
            bridge: 0,
            service: 0,
            projection: 0,
            identityCreate: 0,
          },
        });
        Object.assign(fixture, {
          dedicated: refusal === "dedicated-owned",
          nativePrimary:
            refusal === "unknown-primary"
              ? null
              : {
                  id:
                    refusal === "policy-account-mismatch"
                      ? "00000000-0000-4000-8000-000000000099"
                      : policy.userId,
                  organization_id: policy.organizationId,
                  phone_number: policy.phoneNumber,
                  phone_verified: true,
                  is_active: true,
                  deleted_at: null,
                  organization: { is_active: true },
                },
        });
        bodies.length = 0;
        names.length = 0;
        const open = {
          platform: "blooio",
          project: "eliza-app",
          connectorAccountId: policy.connectorAccountId,
          phoneNumber: policy.phoneNumber,
          messageId: `blooio:eliza-app:${refusal}`,
          message: "Synthetic owned request",
          transport: "sms",
          networkTurn: {
            channel: "blooio",
            app: "slop",
            memberId: "synthetic-member",
            messageId: refusal,
            context: {
              firstName: "Alex",
              city: "sf",
              state: "open",
              stateFrom: null,
              stateUntil: null,
              facets: [],
              activeItems: [],
              singlePlayer: false,
            },
          },
        };
        const wire =
          outcome === "open"
            ? open
            : {
                platform: open.platform,
                project: open.project,
                connectorAccountId: open.connectorAccountId,
                phoneNumber: open.phoneNumber,
                messageId: open.messageId,
                message: open.message,
                transport: open.transport,
                networkHandled: {
                  request: {
                    messageId: refusal,
                    channel: "blooio",
                    from: policy.phoneNumber,
                    to: null,
                    text: open.message,
                    transport: "sms",
                    receivedAt: 1,
                  },
                  response: {
                    outcome: "handled",
                    replies: ["Synthetic reply"],
                    replyIds: ["synthetic-reply"],
                    delivery: "collected",
                    replyKind: "reply",
                    accountEligible: true,
                    app: "slop",
                    memberId: "synthetic-member",
                    reason: "profile_accepted",
                  },
                },
              };
        const raw = JSON.stringify(wire),
          path = "/api/internal/eliza-app/personal-shared/messages";
        const signed = await svcSign(secret, {
          method: "POST",
          path,
          id: refusal,
          body: raw,
        });
        const response = await app.fetch(
          new Request("http://route-fixture.test" + path, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...signed },
            body: raw,
          }),
          {
            NETWORK_PERSONAL_CONTINUITY_ENABLED: "true",
            NETWORK_OWNED_INGRESS_POLICY: JSON.stringify(policy),
            SERVICE_TURN_SECRET: secret,
          },
        );
        expect(response.status).toBe(refusal === "dedicated-owned" ? 409 : 403);
        expect(bodies).toHaveLength(0);
        expect(names).toHaveLength(0);
        expect(Reflect.get(fixture, "nativeEffects")).toEqual({
          prewarm: 0,
          bridge: 0,
          service: 0,
          projection: 0,
          identityCreate: 0,
        });
      }
    Object.assign(fixture, {
      dedicated: false,
      nativePrimary: {
        id: policy.userId,
        organization_id: policy.organizationId,
        phone_number: policy.phoneNumber,
        phone_verified: true,
        is_active: true,
        deleted_at: null,
        organization: { is_active: true },
      },
    });
    Object.assign(fixture, {
      nativeAccount: {
        userId: policy.userId,
        organizationId: policy.organizationId,
        isNew: false,
        dedicatedTarget: null,
      },
    });
    bodies.length = 0;
    names.length = 0;
    const handled = {
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: policy.connectorAccountId,
      phoneNumber: policy.phoneNumber,
      messageId: "blooio:eliza-app:synthetic-help",
      message: "help",
      transport: "sms",
      networkHandled: {
        request: {
          messageId: "synthetic-help",
          channel: "blooio",
          from: policy.phoneNumber,
          to: null,
          text: "help",
          transport: "sms",
          receivedAt: 1,
        },
        response: {
          outcome: "handled",
          replies: ["Synthetic help reply"],
          replyIds: ["synthetic-reply"],
          delivery: "collected",
          replyKind: "compliance",
          accountEligible: true,
          app: null,
          memberId: null,
          reason: "help",
        },
      },
    };
    const rawHandled = JSON.stringify(handled),
      nativePath = "/api/internal/eliza-app/personal-shared/messages";
    const signedHandled = await svcSign(secret, {
      method: "POST",
      path: nativePath,
      id: "synthetic-help",
      body: rawHandled,
    });
    expect(
      (
        await app.fetch(
          new Request("http://route-fixture.test" + nativePath, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...signedHandled },
            body: rawHandled,
          }),
          {
            NETWORK_PERSONAL_CONTINUITY_ENABLED: "true",
            NETWORK_OWNED_INGRESS_POLICY: JSON.stringify(policy),
            SERVICE_TURN_SECRET: secret,
          },
        )
      ).status,
    ).toBe(200);
    expect(bodies).toHaveLength(1);
    const nativeBody = bodies[0] as unknown as {
      operation: string;
      delivery: { app?: string; inbound: { transport: string } };
      trustedNetworkAdmission: { originalBody: string };
    };
    expect(nativeBody.operation).toBe("network-delivery");
    expect(nativeBody.delivery.app).toBeUndefined();
    expect(nativeBody.delivery.inbound.transport).toBe("sms");
    expect(nativeBody.trustedNetworkAdmission.originalBody).toBe(rawHandled);
  } finally {
    Reflect.deleteProperty(globalThis, "__roomRouteFixture");
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
