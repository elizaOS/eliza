/** Postgres NetworkStore and invite acceptance against the real 0474 schema on PGlite. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  legacyNetworkPersonalSharedAgentId,
  personalSharedAgentId,
} from "../services/shared-runtime/personal-shared-identity";
import { createPostgresNetworkStore, sharedNetworkExecution } from "./member-store";
import { createPostgresNetworkMembership } from "./membership";

const USER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ORG = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
const OTHER_USER = "00000000-0000-4000-8000-000000000001";
const PHONE = "+14155550123";

let database: PGlite;
let db: ReturnType<typeof drizzle>;

beforeEach(async () => {
  database = new PGlite();
  await database.exec(
    await readFile(new URL("../../db/migrations/0474_network_core.sql", import.meta.url), "utf8"),
  );
  db = drizzle(database);
});
afterEach(async () => {
  await database.close();
});

describe("invite acceptance", () => {
  test("first message from an invited phone creates and links the member, idempotently", async () => {
    const membership = createPostgresNetworkMembership(db);
    const { token } = await membership.createInvite({ phoneE164: PHONE });
    expect(token.length).toBeGreaterThan(20);
    const stored = await database.query<{ token_hash: string; status: string }>(
      `SELECT token_hash, status FROM network.invites`,
    );
    expect(stored.rows[0]?.token_hash).not.toBe(token);
    expect(stored.rows[0]?.status).toBe("pending");

    const first = await membership.linkInvitedPhone({
      phoneE164: PHONE,
      cloudUserId: USER,
      organizationId: ORG,
    });
    expect(first).toMatchObject({ kind: "linked", acceptedInvites: 1, created: true });
    const again = await membership.linkInvitedPhone({
      phoneE164: PHONE,
      cloudUserId: USER,
      organizationId: ORG,
    });
    expect(again).toEqual({
      kind: "linked",
      memberId: first.kind === "linked" ? first.memberId : "",
      acceptedInvites: 0,
      created: false,
    });
    const members = await database.query<{ cloud_user_id: string }>(
      `SELECT cloud_user_id FROM network.members`,
    );
    expect(members.rows).toEqual([{ cloud_user_id: USER }]);
    const invites = await database.query<{ status: string; accepted_member_id: string }>(
      `SELECT status, accepted_member_id FROM network.invites`,
    );
    expect(invites.rows).toEqual([
      { status: "accepted", accepted_member_id: first.kind === "linked" ? first.memberId : "" },
    ]);
  });

  test("an admin-created member is linked on first contact; uninvited phones are refused", async () => {
    const membership = createPostgresNetworkMembership(db);
    const created = await membership.upsertMember({
      phoneE164: PHONE,
      firstName: "Ada",
      city: "SF",
    });
    expect(created.created).toBe(true);
    expect((await membership.upsertMember({ phoneE164: PHONE, firstName: "X" })).memberId).toBe(
      created.memberId,
    );
    expect(
      await membership.linkInvitedPhone({
        phoneE164: PHONE,
        cloudUserId: USER,
        organizationId: ORG,
      }),
    ).toMatchObject({ kind: "linked", memberId: created.memberId, created: false });
    expect(
      await membership.linkInvitedPhone({
        phoneE164: "+14155550999",
        cloudUserId: OTHER_USER,
        organizationId: ORG,
      }),
    ).toEqual({ kind: "not_invited" });
    expect(
      (await database.query(`SELECT 1 FROM network.members WHERE phone_e164 = '+14155550999'`))
        .rows,
    ).toEqual([]);
  });

  test("a phone already linked to another account is never relinked", async () => {
    const membership = createPostgresNetworkMembership(db);
    await membership.createInvite({ phoneE164: PHONE });
    await membership.linkInvitedPhone({ phoneE164: PHONE, cloudUserId: USER, organizationId: ORG });
    const mismatch = await membership.linkInvitedPhone({
      phoneE164: PHONE,
      cloudUserId: OTHER_USER,
      organizationId: ORG,
    });
    expect(mismatch.kind).toBe("account_mismatch");
    expect(
      (await database.query<{ cloud_user_id: string }>(`SELECT cloud_user_id FROM network.members`))
        .rows,
    ).toEqual([{ cloud_user_id: USER }]);
  });

  test("expired invites do not admit", async () => {
    const membership = createPostgresNetworkMembership(db);
    await membership.createInvite({ phoneE164: PHONE, expiresAt: new Date(Date.now() - 1000) });
    expect(
      await membership.linkInvitedPhone({
        phoneE164: PHONE,
        cloudUserId: USER,
        organizationId: ORG,
      }),
    ).toEqual({ kind: "not_invited" });
  });
});

describe("Postgres NetworkStore", () => {
  async function seedMember() {
    const membership = createPostgresNetworkMembership(db);
    await membership.upsertMember({
      phoneE164: PHONE,
      firstName: "Ada",
      city: "San Francisco",
      facets: ["climbs at Mission Cliffs", 'likes "quoted" things'],
    });
    await membership.linkInvitedPhone({ phoneE164: PHONE, cloudUserId: USER, organizationId: ORG });
  }

  test("MEMBER_CONTEXT reads the linked member by Cloud user id", async () => {
    const store = createPostgresNetworkStore(db);
    expect(await store.getMemberContext(USER)).toBeNull();
    await seedMember();
    const member = await store.getMemberContext(USER);
    expect(member).toMatchObject({
      firstName: "Ada",
      city: "San Francisco",
      state: "open",
      stateUntil: null,
      facets: ["climbs at Mission Cliffs", 'likes "quoted" things'],
      activeItems: [],
    });
    expect(await store.getMemberContext(OTHER_USER)).toBeNull();
  });

  test("SET_STATE applies once per idempotency key and replays the stored event", async () => {
    await seedMember();
    const store = createPostgresNetworkStore(db);
    const input = {
      memberId: USER,
      state: "paused" as const,
      until: "2026-10-20T00:00:00.000Z",
      note: "swamped",
      idempotencyKey: "network:set_state:v1:msg-1:0",
    };
    const applied = await store.setState(input);
    expect(applied).toMatchObject({
      previous: "open",
      current: "paused",
      until: "2026-10-20T00:00:00.000Z",
      replayed: false,
    });
    expect(applied.eventId).toMatch(/^evt-[0-9]+$/);
    // A later change, then a replay of the first key: no state regression.
    await store.setState({ ...input, state: "busy", until: null, idempotencyKey: "k2" });
    const replay = await store.setState(input);
    expect(replay).toMatchObject({ eventId: applied.eventId, current: "paused", replayed: true });
    expect((await store.getMemberContext(USER))?.state).toBe("busy");
    const events = await database.query(`SELECT 1 FROM network.member_events`);
    expect(events.rows).toHaveLength(2);
    await expect(
      store.setState({ ...input, memberId: OTHER_USER, idempotencyKey: "k3" }),
    ).rejects.toThrow("Network member is not available");
  });

  test("SET_STATE to the current state and end date writes no event (unchanged)", async () => {
    await seedMember();
    const store = createPostgresNetworkStore(db);
    const noop = await store.setState({
      memberId: USER,
      state: "open",
      until: null,
      note: null,
      idempotencyKey: "noop-1",
    });
    expect(noop).toMatchObject({
      eventId: null,
      previous: "open",
      current: "open",
      unchanged: true,
      replayed: false,
    });
    expect((await database.query(`SELECT 1 FROM network.member_events`)).rows).toHaveLength(0);
    // Same state with a different end date is a real change.
    const paused = { memberId: USER, state: "paused" as const, note: null };
    await store.setState({ ...paused, until: "2026-10-20T00:00:00.000Z", idempotencyKey: "p1" });
    const extended = await store.setState({
      ...paused,
      until: "2026-10-27T00:00:00.000Z",
      idempotencyKey: "p2",
    });
    expect(extended).toMatchObject({
      unchanged: false,
      current: "paused",
      until: "2026-10-27T00:00:00.000Z",
    });
    const same = await store.setState({
      ...paused,
      until: "2026-10-27T00:00:00.000Z",
      idempotencyKey: "p3",
    });
    expect(same).toMatchObject({ unchanged: true, eventId: null });
    expect((await database.query(`SELECT 1 FROM network.member_events`)).rows).toHaveLength(2);
  });

  test("SET_STATE stores a future presence window and reads it back", async () => {
    await seedMember();
    const store = createPostgresNetworkStore(db);
    const trip = {
      memberId: USER,
      state: "traveling" as const,
      from: "2026-10-12T00:00:00.000Z",
      until: "2026-10-15T00:00:00.000Z",
      note: null,
    };
    const applied = await store.setState({ ...trip, idempotencyKey: "w1" });
    expect(applied).toMatchObject({
      current: "traveling",
      from: trip.from,
      until: trip.until,
      unchanged: false,
    });
    expect(await store.getMemberContext(USER)).toMatchObject({
      state: "traveling",
      stateFrom: trip.from,
      stateUntil: trip.until,
    });
    // Same window again: no event. A different start date: a real change.
    expect(await store.setState({ ...trip, idempotencyKey: "w2" })).toMatchObject({
      unchanged: true,
      eventId: null,
    });
    expect(
      await store.setState({ ...trip, from: "2026-10-13T00:00:00.000Z", idempotencyKey: "w3" }),
    ).toMatchObject({ unchanged: false });
    expect((await database.query(`SELECT 1 FROM network.member_events`)).rows).toHaveLength(2);
  });

  test("signals are recorded once per (message, kind)", async () => {
    await seedMember();
    const store = createPostgresNetworkStore(db);
    const signals = [
      { kind: "travel" as const, evidence: "in Austin next week" },
      { kind: "opt_out" as const, evidence: "stop texting me" },
    ];
    expect(await store.recordSignals({ memberId: USER, messageId: "m1", signals })).toEqual({
      recorded: 2,
    });
    expect(await store.recordSignals({ memberId: USER, messageId: "m1", signals })).toEqual({
      recorded: 0,
    });
    expect(await store.recordSignals({ memberId: OTHER_USER, messageId: "m1", signals })).toEqual({
      recorded: 0,
    });
  });
});

describe("sharedNetworkExecution", () => {
  const store = createPostgresNetworkStore(async () => {
    throw new Error("not used");
  });
  const factory = () => store;
  test("only canonical Network DMs get a member store", () => {
    const agent = {
      id: personalSharedAgentId({ userId: USER, organizationId: ORG }),
      user_id: USER,
      organization_id: ORG,
      execution_tier: "shared" as const,
    };
    expect(sharedNetworkExecution({ ...agent, project: "network" }, true, false, factory)).toEqual({
      memberId: USER,
      store,
    });
    for (const forged of [
      { ...agent, id: legacyNetworkPersonalSharedAgentId({ userId: USER, organizationId: ORG }) },
      { ...agent, user_id: OTHER_USER },
      { ...agent, organization_id: "foreign-org" },
      { ...agent, execution_tier: "dedicated-always" as const },
    ]) {
      expect(
        sharedNetworkExecution({ ...forged, project: "network" }, true, false, factory),
      ).toBeUndefined();
    }
    expect(sharedNetworkExecution(agent, true, false, factory)).toBeUndefined();
    expect(
      sharedNetworkExecution({ ...agent, project: "eliza-app" }, true, false, factory),
    ).toBeUndefined();
    expect(
      sharedNetworkExecution({ ...agent, project: "network" }, false, false, factory),
    ).toBeUndefined();
    expect(
      sharedNetworkExecution({ ...agent, project: "network" }, true, true, factory),
    ).toBeUndefined();
  });
});
