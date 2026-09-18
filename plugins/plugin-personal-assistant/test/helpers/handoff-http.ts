/** Builds isolated real-runtime and loopback HTTP fixtures for account-handoff flows; only external Google discovery is deterministic. */
import { once } from "node:events";
import { createServer } from "node:http";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import { getConnectorAccountManager, stringToUuid } from "@elizaos/core";
import { personalAssistantRoutesPlugin } from "../../src/routes/plugin.js";
import { googleHandoffFixture } from "./handoff-google.js";
import type { RealTestRuntimeResult } from "./runtime.js";

export const owner = stringToUuid("handoff-http-owner");
export const otherOwner = stringToUuid("handoff-http-other-owner");
export const token = "synthetic-handoff-http-owner-token";

export async function createHandoffHttpFixture(
  host: RealTestRuntimeResult,
  grantedScopes: string[],
) {
  const serverErrors: Error[] = [];
  const choices = {
    operationId: "http-review",
    previousGrantId: "connector-account:http-old",
    replacementGrantId: "connector-account:http-new",
    readCalendarIds: ["reviewed-calendar"],
    writeCalendarId: null,
    calendarLinks: [],
    messageDestinations: [
      {
        channel: "email" as const,
        connectorAccountId: "http-new",
        recipientId: "recipient@example.test",
        recipientEntityId: owner,
      },
    ],
    importedData: "retain" as const,
    retireApprovalIds: [],
  };
  host.runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", owner);
  const provider = await host.runtime.getServiceLoadPromise("google");
  Object.assign(provider, {
    listCalendars: async () => [googleHandoffFixture().entry],
  });
  const manager = getConnectorAccountManager(host.runtime);
  manager.registerProvider({ provider: "google" });
  for (const id of ["http-old", "http-new"]) {
    const saved = await manager.upsertAccount("google", {
      id,
      provider: "google",
      role: "OWNER",
      purpose: ["reading"],
      accessGate: "owner_binding",
      status: "connected",
      displayHandle: `${id}@example.test`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        grantedScopes,
      },
    });
    if (id === "http-old")
      choices.previousGrantId = `connector-account:${saved.id}`;
    else {
      choices.replacementGrantId = `connector-account:${saved.id}`;
      const destination = choices.messageDestinations[0];
      if (!destination) throw new Error("Fixture recipient missing");
      destination.connectorAccountId = saved.id;
    }
  }
  const graph = resolveKnowledgeGraphService(host.runtime);
  if (!graph) throw new Error("Fixture graph missing");
  await graph.getEntityStore(host.runtime.agentId).upsert({
    entityId: owner,
    type: "person",
    preferredName: "Synthetic recipient",
    identities: [
      {
        platform: "email",
        handle: "recipient@example.test",
        connectorAccountId: "default",
        verified: true,
        confidence: 1,
        addedAt: "2026-09-01T00:00:00Z",
        addedVia: "user_chat",
        evidence: ["Synthetic confirmation"],
      },
    ],
    tags: [],
    visibility: "owner_only",
    state: {},
  });
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const path =
      pathname === "/api/lifeops/account-handoffs" ||
      pathname.endsWith("/active") ||
      pathname.endsWith("/retirement-candidates") ||
      pathname.endsWith("/calendar-entries")
        ? pathname
        : pathname.endsWith("/cancel")
          ? "/api/lifeops/account-handoffs/:operationId/cancel"
          : pathname.endsWith("/advance")
            ? "/api/lifeops/account-handoffs/:operationId/advance"
            : "/api/lifeops/account-handoffs/:operationId";
    const route = personalAssistantRoutesPlugin.routes?.find(
      (item) => item.type === req.method && item.path === path,
    );
    if (!route?.handler) {
      res.writeHead(404).end();
      return;
    }
    Promise.resolve(
      route.handler(req as never, res as never, host.runtime as never),
    ).catch((error) => {
      // error-policy:J1 Test HTTP boundary records unexpected failures before closing the response.
      serverErrors.push(
        error instanceof Error ? error : new Error(String(error)),
      );
      res.writeHead(500).end("Unexpected test server failure");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server address missing");
  const baseUrl = `http://127.0.0.1:${address.port}/api/lifeops/account-handoffs`;
  return {
    host,
    baseUrl,
    choices,
    serverErrors,
    async cleanup() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
