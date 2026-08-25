/**
 * Exercises the group participant identity registry against isolated PGlite
 * with the real 0311 migration: first-seen ordinal assignment, a stable
 * ordinal across a participant's whole history, connector-supplied names and
 * the rules that reject them, per-binding isolation, and the roster every
 * group turn hands to the outbound handle guard.
 *
 * PGlite serializes transactions, so the true interleaving of two first-time
 * speakers is proven in the sibling `.postgres.integration.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG = "74000000-0000-4000-8000-000000000001";
const USER = "74000000-0000-4000-8000-000000000011";
const BINDING = "74000000-0000-4000-8000-000000000021";
const OTHER_BINDING = "74000000-0000-4000-8000-000000000022";
const ADA = "+15551234567";
const BRIT = "+15559990000";
const CHEN = "+15557654321";

let closeDatabaseConnectionsForTests:
  | typeof import("../client").closeDatabaseConnectionsForTests
  | undefined;
let getPgliteClientForTests: typeof import("../client").getPgliteClientForTests;
let repository: typeof import("./personal-shared-group-participants").personalSharedGroupParticipantsRepository;
let groupParticipantLabel: typeof import("../../lib/services/shared-runtime/group-participant-labels").groupParticipantLabel;

function recordTurn(platformUserId: string, bindingId = BINDING, displayName?: string | null) {
  return repository.recordTurn({ bindingId, platformUserId, displayName });
}

async function storedRows(bindingId = BINDING) {
  const { rows } = await getPgliteClientForTests().query<{
    platform_user_id: string;
    ordinal: number;
    display_name: string | null;
    first_seen_at: Date;
    last_seen_at: Date;
  }>(
    `SELECT platform_user_id, ordinal, display_name, first_seen_at, last_seen_at
     FROM personal_shared_group_participants
     WHERE binding_id = $1 ORDER BY ordinal`,
    [bindingId],
  );
  return rows;
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, getPgliteClientForTests } = await import("../client"));
  ({ personalSharedGroupParticipantsRepository: repository } = await import(
    "./personal-shared-group-participants"
  ));
  ({ groupParticipantLabel } = await import(
    "../../lib/services/shared-runtime/group-participant-labels"
  ));
  const database = getPgliteClientForTests();
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
  `);
  for (const file of [
    "0297_personal_shared_group_bindings.sql",
    "0311_personal_shared_group_participants.sql",
  ]) {
    await database.exec(await Bun.file(new URL(`../migrations/${file}`, import.meta.url)).text());
  }
});

beforeEach(async () => {
  const database = getPgliteClientForTests();
  await database.exec(`
    TRUNCATE personal_shared_group_participants,
      personal_shared_group_bindings,
      users,
      organizations CASCADE;
    INSERT INTO organizations (id) VALUES ('${ORG}');
    INSERT INTO users (id) VALUES ('${USER}');
  `);
  for (const id of [BINDING, OTHER_BINDING]) {
    await database.query(
      `INSERT INTO personal_shared_group_bindings
         (id, organization_id, owner_user_id, personal_agent_id, platform, project,
          connector_account_id, provider_chat_id, conversation_id,
          created_by_platform_user_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'agent-1', 'blooio', 'eliza-app',
         '+15550000001', $4, $5, $6)`,
      [id, ORG, USER, `chat:${id}`, `group:${id}`, ADA],
    );
  }
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("personalSharedGroupParticipantsRepository", () => {
  test("assigns 1-based ordinals in first-seen order and returns the roster", async () => {
    expect(await recordTurn(ADA)).toEqual({
      actor: { platformUserId: ADA, ordinal: 1, displayName: null },
      roster: [{ platformUserId: ADA, ordinal: 1, displayName: null }],
    });
    const second = await recordTurn(BRIT);
    expect(second.actor).toEqual({ platformUserId: BRIT, ordinal: 2, displayName: null });
    // The roster is the whole binding, not just the speaker: the outbound guard
    // must be able to redact anyone's handle, not only the current one.
    expect(second.roster.map(({ ordinal }) => ordinal)).toEqual([1, 2]);
    expect(second.roster.map(({ platformUserId }) => platformUserId)).toEqual([ADA, BRIT]);
    expect((await recordTurn(CHEN)).actor.ordinal).toBe(3);
  });

  test("keeps a participant's ordinal stable across every later turn", async () => {
    await recordTurn(ADA);
    await recordTurn(BRIT);
    // Re-speaking must not mint a new ordinal, or history stops being readable.
    expect((await recordTurn(ADA)).actor.ordinal).toBe(1);
    expect((await recordTurn(ADA)).actor.ordinal).toBe(1);
    expect((await recordTurn(BRIT)).actor.ordinal).toBe(2);
    expect((await storedRows()).map(({ ordinal }) => ordinal)).toEqual([1, 2]);
  });

  test("refreshes last seen without moving first seen", async () => {
    await recordTurn(ADA);
    const [before] = await storedRows();
    if (!before) throw new Error("participant row missing");
    await recordTurn(ADA);
    const [after] = await storedRows();
    if (!after) throw new Error("participant row missing");
    expect(after.first_seen_at.getTime()).toBe(before.first_seen_at.getTime());
    expect(after.last_seen_at.getTime()).toBeGreaterThanOrEqual(before.last_seen_at.getTime());
  });

  test("numbers each binding independently", async () => {
    await recordTurn(ADA);
    await recordTurn(BRIT);
    // The same person in another group starts that group's count over, so a
    // label never carries meaning from one room into another.
    expect((await recordTurn(BRIT, OTHER_BINDING)).actor.ordinal).toBe(1);
    const elsewhere = await recordTurn(ADA, OTHER_BINDING);
    expect(elsewhere.actor.ordinal).toBe(2);
    // The roster handed to the outbound guard is this binding's members only:
    // another group's handles must never be redactable here, and its labels
    // must never be substitutable into this group's reply.
    expect(elsewhere.roster).toEqual([
      { platformUserId: BRIT, ordinal: 1, displayName: null },
      { platformUserId: ADA, ordinal: 2, displayName: null },
    ]);
    expect((await storedRows()).map(({ platform_user_id }) => platform_user_id)).toEqual([
      ADA,
      BRIT,
    ]);
    expect(
      (await storedRows(OTHER_BINDING)).map(({ platform_user_id }) => platform_user_id),
    ).toEqual([BRIT, ADA]);
  });

  test("concurrent first-time speakers never share an ordinal", async () => {
    const turns = await Promise.all([recordTurn(ADA), recordTurn(BRIT), recordTurn(CHEN)]);
    const ordinals = turns.map(({ actor }) => actor.ordinal).sort();
    expect(ordinals).toEqual([1, 2, 3]);
    expect(new Set(turns.map(({ actor }) => actor.platformUserId)).size).toBe(3);
    expect((await storedRows()).map(({ ordinal }) => ordinal)).toEqual([1, 2, 3]);
  });

  test("concurrent turns from one participant register them once", async () => {
    const turns = await Promise.all([recordTurn(ADA), recordTurn(ADA), recordTurn(ADA)]);
    expect(turns.map(({ actor }) => actor.ordinal)).toEqual([1, 1, 1]);
    expect(await storedRows()).toHaveLength(1);
  });

  test("labels by ordinal when the connector sends no name", async () => {
    // Blooio never sends one, so this is the shipped path for every iMessage
    // room and what tonight's live evaluation measured.
    const { actor } = await recordTurn(ADA);
    expect(actor.displayName).toBeNull();
    expect(groupParticipantLabel(actor)).toBe("Participant 1");
    expect((await storedRows())[0]?.display_name).toBeNull();
  });

  test("stores and labels by a name the connector supplies", async () => {
    const { actor } = await recordTurn(ADA, BINDING, "Ada");
    expect(actor).toEqual({ platformUserId: ADA, ordinal: 1, displayName: "Ada" });
    expect(groupParticipantLabel(actor)).toBe("Ada");
    expect((await storedRows())[0]?.display_name).toBe("Ada");
  });

  test("follows a member who renames themselves", async () => {
    await recordTurn(ADA, BINDING, "Ada");
    const renamed = await recordTurn(ADA, BINDING, "Ada L");
    expect(renamed.actor).toEqual({ platformUserId: ADA, ordinal: 1, displayName: "Ada L" });
    // The ordinal is untouched by a rename, so history stays readable.
    expect((await storedRows())[0]?.ordinal).toBe(1);
    expect((await storedRows())[0]?.display_name).toBe("Ada L");
  });

  test("reverts to the ordinal when a name stops being usable", async () => {
    await recordTurn(ADA, BINDING, "Ada");
    // A rejected or withdrawn name must not leave a stale label behind.
    const forged = await recordTurn(ADA, BINDING, "Participant 7");
    expect(forged.actor.displayName).toBeNull();
    expect(groupParticipantLabel(forged.actor)).toBe("Participant 1");
    expect((await storedRows())[0]?.display_name).toBeNull();

    await recordTurn(ADA, BINDING, "Ada");
    expect((await storedRows())[0]?.display_name).toBe("Ada");
    const withdrawn = await recordTurn(ADA, BINDING, undefined);
    expect(withdrawn.actor.displayName).toBeNull();
    expect((await storedRows())[0]?.display_name).toBeNull();
  });

  test("never lets two participants of one binding render identically", async () => {
    await recordTurn(ADA, BINDING, "Nubs");
    // First claimant keeps the name; an impersonator becomes their own ordinal
    // rather than a second copy of someone who is already in the room.
    const impostor = await recordTurn(BRIT, BINDING, "Nubs");
    expect(impostor.actor.displayName).toBeNull();
    expect(impostor.roster.map(groupParticipantLabel)).toEqual(["Nubs", "Participant 2"]);
    expect(new Set(impostor.roster.map(groupParticipantLabel)).size).toBe(2);
    // The name is free again in a different binding.
    expect((await recordTurn(BRIT, OTHER_BINDING, "Nubs")).actor.displayName).toBe("Nubs");
  });

  test("refuses a name that would put a participant handle in the prompt", async () => {
    await recordTurn(ADA, BINDING, "Ada");
    const smuggler = await recordTurn(BRIT, BINDING, `reach me on ${ADA}`);
    expect(smuggler.actor.displayName).toBeNull();
    expect(groupParticipantLabel(smuggler.actor)).toBe("Participant 2");
  });

  test("fails closed on an identity the route could not have resolved", async () => {
    await expect(repository.recordTurn({ bindingId: "", platformUserId: ADA })).rejects.toThrow(
      TypeError,
    );
    await expect(repository.recordTurn({ bindingId: BINDING, platformUserId: "" })).rejects.toThrow(
      TypeError,
    );
    // A binding that does not exist must not silently produce a label.
    await expect(recordTurn(ADA, "74000000-0000-4000-8000-0000000000ff")).rejects.toThrow(
      /Group participant registration failed/,
    );
  });
});
