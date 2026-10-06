/** Network inbound gate decisions, against the stub store and the real 0474 schema. */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  evaluateNetworkInboundGate,
  InMemoryNetworkInviteStore,
  NETWORK_INVITE_REQUIRED_REPLY,
} from "./inbound-gate";
import { createPostgresNetworkInviteLookup } from "./invite-lookup";

describe("evaluateNetworkInboundGate", () => {
  test("non-network projects are allowed without consulting the store", async () => {
    const store = new InMemoryNetworkInviteStore();
    for (const project of ["eliza-app", "soulmates", undefined]) {
      expect(
        await evaluateNetworkInboundGate(
          { project, platform: "twilio", phoneNumber: "+14155550100" },
          store,
        ),
      ).toEqual({ kind: "allow" });
      expect(
        await evaluateNetworkInboundGate({ project, platform: "blooio", chatType: "group" }, store),
      ).toEqual({ kind: "allow" });
    }
    expect(store.lookups).toEqual([]);
  });

  test("network phones need an accepted invite; groups are dropped", async () => {
    const store = new InMemoryNetworkInviteStore(["+14155550101"]);
    expect(
      await evaluateNetworkInboundGate(
        { project: "network", platform: "twilio", phoneNumber: "+14155550101" },
        store,
      ),
    ).toEqual({ kind: "allow" });
    expect(
      await evaluateNetworkInboundGate(
        { project: "network", platform: "blooio", phoneNumber: "+14155550102" },
        store,
      ),
    ).toEqual({
      kind: "reply",
      code: "network_invite_required",
      reply: NETWORK_INVITE_REQUIRED_REPLY,
    });
    expect(
      await evaluateNetworkInboundGate(
        { project: "network", platform: "telegram", chatType: "supergroup" },
        store,
      ),
    ).toEqual({ kind: "drop", code: "network_group_unsupported" });
    expect(store.lookups).toEqual(["+14155550101", "+14155550102"]);
  });
});

describe("createPostgresNetworkInviteLookup", () => {
  const databases: PGlite[] = [];
  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  });

  test("admits live or accepted invites and live members only", async () => {
    const database = new PGlite();
    databases.push(database);
    await database.exec(
      await readFile(new URL("../../db/migrations/0474_network_core.sql", import.meta.url), "utf8"),
    );
    await database.exec(`
      INSERT INTO "network"."invites" ("phone_e164", "token_hash", "status", "accepted_at")
        VALUES ('+14155550110', 'accepted', 'accepted', now()),
               ('+14155550111', 'pending', 'pending', NULL),
               ('+14155550112', 'revoked', 'revoked', NULL);
      INSERT INTO "network"."invites" ("phone_e164", "token_hash", "status", "expires_at")
        VALUES ('+14155550115', 'expired', 'pending', now() - interval '1 day');
      INSERT INTO "network"."members" ("phone_e164", "state")
        VALUES ('+14155550113', 'paused'), ('+14155550114', 'removed');
    `);
    const lookup = createPostgresNetworkInviteLookup(drizzle(database) as never);
    const admitted = async (address: string) =>
      await lookup.isInvitedOrMember({ channel: "phone", address });
    expect(await admitted("+14155550110")).toBe(true);
    // A live pending invite admits the first message, which then accepts it.
    expect(await admitted("+14155550111")).toBe(true);
    expect(await admitted("+14155550115")).toBe(false);
    expect(await admitted("+14155550112")).toBe(false);
    expect(await admitted("+14155550113")).toBe(true);
    expect(await admitted("+14155550114")).toBe(false);
    expect(await admitted("+14155550199")).toBe(false);
  });
});
