/**
 * Exercises the character-delete identity fence through the real repository
 * against isolated PGlite tables generated from the production Drizzle schema.
 *
 * PGlite exposes a single database session, so it cannot faithfully interleave
 * a competing FK insert with the delete transaction. The production race is
 * closed by PostgreSQL lock semantics: the explicit parent FOR UPDATE conflicts
 * with the KEY SHARE lock taken while validating agent_sandboxes.character_id.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { DbTransaction } from "../client";
import { agentNodeIncarnationHistories } from "../schemas/agent-node-incarnation-histories";
import { agentSandboxes } from "../schemas/agent-sandboxes";
import { organizationBalanceRevisionSequence, organizations } from "../schemas/organizations";
import { userCharacters } from "../schemas/user-characters";
import { users } from "../schemas/users";
import { CharacterLinkedSandboxConflictError, UserCharactersRepository } from "./characters";

const ORGANIZATION_ID = "00000000-0000-4000-8000-00000000c101";
const USER_ID = "00000000-0000-4000-8000-00000000c102";
const UNLINKED_CHARACTER_ID = "00000000-0000-4000-8000-00000000c103";
const LINKED_CHARACTER_ID = "00000000-0000-4000-8000-00000000c104";
const SANDBOX_ID = "00000000-0000-4000-8000-00000000c105";
const DELETION_ATTEMPT_ID = "00000000-0000-4000-8000-00000000c106";

const client = new PGlite();
const schema = {
  organizationBalanceRevisionSequence,
  organizations,
  users,
  userCharacters,
  agentNodeIncarnationHistories,
  agentSandboxes,
};
const database = drizzle({ client, schema });
const repository = new UserCharactersRepository(
  async <T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> =>
    database.transaction((tx) => work(tx as unknown as DbTransaction)),
);

async function seedCharacter(id: string, name: string): Promise<void> {
  await database.insert(userCharacters).values({
    id,
    organization_id: ORGANIZATION_ID,
    user_id: USER_ID,
    name,
    bio: [],
    character_data: {},
  });
}

beforeAll(async () => {
  const { apply } = await pushSchema(schema as never, database as never);
  await apply();
});

beforeEach(async () => {
  await database.delete(agentSandboxes);
  await database.delete(userCharacters);
  await database.delete(users);
  await database.delete(organizations);

  await database.insert(organizations).values({
    id: ORGANIZATION_ID,
    name: "Character identity fence",
    slug: "character-identity-fence",
  });
  await database.insert(users).values({
    id: USER_ID,
    organization_id: ORGANIZATION_ID,
    steward_user_id: "character-identity-fence-user",
  });
});

afterAll(async () => {
  await client.close();
});

describe("UserCharactersRepository.delete identity fence", () => {
  test("deletes an unlinked character", async () => {
    await seedCharacter(UNLINKED_CHARACTER_ID, "Unlinked character");

    await repository.delete(UNLINKED_CHARACTER_ID);

    const rows = await database
      .select({ id: userCharacters.id })
      .from(userCharacters)
      .where(eq(userCharacters.id, UNLINKED_CHARACTER_ID));
    expect(rows).toEqual([]);
  });

  test("refuses a deletion-fenced sandbox identity without mutating either row", async () => {
    await seedCharacter(LINKED_CHARACTER_ID, "Linked character");
    const deletionStartedAt = new Date("2026-08-25T10:00:00.000Z");
    const deletedAt = new Date("2026-08-25T10:01:00.000Z");
    await database.insert(agentSandboxes).values({
      id: SANDBOX_ID,
      organization_id: ORGANIZATION_ID,
      user_id: USER_ID,
      character_id: LINKED_CHARACTER_ID,
      agent_name: "Deletion-fenced agent",
      status: "deletion_failed",
      deletion_attempt_id: DELETION_ATTEMPT_ID,
      deletion_started_at: deletionStartedAt,
      deleted_at: deletedAt,
    });

    let caught: unknown;
    try {
      await repository.delete(LINKED_CHARACTER_ID);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CharacterLinkedSandboxConflictError);
    expect(caught).toMatchObject({
      characterId: LINKED_CHARACTER_ID,
      sandboxId: SANDBOX_ID,
    });

    const [character] = await database
      .select({ id: userCharacters.id })
      .from(userCharacters)
      .where(eq(userCharacters.id, LINKED_CHARACTER_ID));
    const [sandbox] = await database
      .select({
        id: agentSandboxes.id,
        characterId: agentSandboxes.character_id,
        status: agentSandboxes.status,
        deletionAttemptId: agentSandboxes.deletion_attempt_id,
        deletedAt: agentSandboxes.deleted_at,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, SANDBOX_ID));

    expect(character?.id).toBe(LINKED_CHARACTER_ID);
    expect(sandbox).toEqual({
      id: SANDBOX_ID,
      characterId: LINKED_CHARACTER_ID,
      status: "deletion_failed",
      deletionAttemptId: DELETION_ATTEMPT_ID,
      deletedAt,
    });
  });
});
