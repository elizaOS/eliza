/**
 * Drives repeat-turn Telegram and Discord resolution against the real Drizzle
 * schema on isolated PGlite, including single-statement reuse, exact Dedicated
 * authority, stale-projection repair, and concurrent first contact.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import {
  AGENT_PERSONAL_CUTOVER_KEY,
  AGENT_UPGRADED_FROM_KEY,
} from "../../lib/services/eliza-agent-config";
import { elizaAppUserService } from "../../lib/services/eliza-app/user-service";
import { personalSharedAgentId } from "../../lib/services/shared-runtime/personal-shared-agent";
import { closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests } from "../client";
import { agentSandboxes } from "../schemas/agent-sandboxes";
import { apiKeys } from "../schemas/api-keys";
import { organizationBalanceRevisionSequence, organizations } from "../schemas/organizations";
import { userCharacters } from "../schemas/user-characters";
import { userIdentities } from "../schemas/user-identities";
import { users } from "../schemas/users";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

function telegramInput(telegramId: string) {
  return {
    platform: "telegram" as const,
    telegramId,
    username: `user_${telegramId}`,
    firstName: "Nubs",
    displayName: "Nubs",
  };
}

function discordInput(discordId: string) {
  return {
    platform: "discord" as const,
    discordId,
    username: `user_${discordId}`,
    globalName: "Nubs",
    avatarUrl: `https://cdn.discordapp.com/avatars/${discordId}/avatar.png`,
  };
}

function phoneInput(phoneNumber: string) {
  return {
    platform: "phone" as const,
    phoneNumber,
  };
}

function cutoverFor(sourceAgentId: string) {
  return {
    mode: "dedicated" as const,
    sourceAgentId,
    conversationId: sourceAgentId,
    cutoverToken: `cutover-${sourceAgentId}`,
    sharedMessageCount: 4,
    sharedScheduledTaskCount: 0,
    sharedTodoCount: 0,
    sharedTodoMutationCount: 0,
    sharedTodoDigest: "0".repeat(64),
    activatedAt: "2026-08-15T12:00:00.000Z",
  };
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[personal-shared-deliveries.integration.test] isolated PGlite is required; refusing to mutate an ambient Postgres database.",
    );
    return;
  }
  try {
    const { apply } = await pushSchema(
      {
        organizationBalanceRevisionSequence,
        organizations,
        users,
        userIdentities,
        userCharacters,
        agentSandboxes,
        apiKeys,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    // error-policy:J1 The test boundary records schema setup failure and every case fails loudly.
    pgliteReady = false;
    console.error(
      "[personal-shared-deliveries.integration.test] PGlite schema setup failed.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(apiKeys);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(userIdentities);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("Telegram personal Shared repeat delivery", () => {
  test("reuses a converged account in one statement without rewriting identity rows", async () => {
    const input = telegramInput("714700101");
    const created = await elizaAppUserService.resolvePersonalDelivery(input);
    const [userBefore] = await dbWrite.select().from(users).where(eq(users.id, created.userId));
    const [projectionBefore] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, created.userId));

    const query = spyOn(getPgliteClientForTests(), "query");
    const replayed = await elizaAppUserService.resolvePersonalDelivery(input);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();

    const [userAfter] = await dbWrite.select().from(users).where(eq(users.id, created.userId));
    const [projectionAfter] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, created.userId));
    expect(replayed).toMatchObject({
      userId: created.userId,
      organizationId: created.organizationId,
      dedicatedTarget: null,
      isNew: false,
      resolution: "single-query-repeat",
    });
    expect(userAfter.updated_at).toEqual(userBefore.updated_at);
    expect(projectionAfter.updated_at).toEqual(projectionBefore.updated_at);
  });

  test("returns the exact authoritative Dedicated target in the repeat statement", async () => {
    const input = telegramInput("714700102");
    const account = await elizaAppUserService.resolvePersonalDelivery(input);
    const sourceAgentId = personalSharedAgentId({
      userId: account.userId,
      organizationId: account.organizationId,
    });
    const [target] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: account.organizationId,
        user_id: account.userId,
        execution_tier: "dedicated-always",
        status: "running",
        bridge_url: "http://127.0.0.1:9876/api/compat/agents/sandbox",
        agent_config: {
          [AGENT_UPGRADED_FROM_KEY]: sourceAgentId,
          [AGENT_PERSONAL_CUTOVER_KEY]: cutoverFor(sourceAgentId),
        },
      })
      .returning();

    const query = spyOn(getPgliteClientForTests(), "query");
    const replayed = await elizaAppUserService.resolvePersonalDelivery(input);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();
    expect(replayed.dedicatedTarget).toMatchObject({
      id: target.id,
      status: "running",
    });
  });

  test("falls back to exact marker authority when another org target is newer", async () => {
    const input = telegramInput("714700105");
    const account = await elizaAppUserService.resolvePersonalDelivery(input);
    const sourceAgentId = personalSharedAgentId({
      userId: account.userId,
      organizationId: account.organizationId,
    });
    const [exact] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: account.organizationId,
        user_id: account.userId,
        execution_tier: "dedicated-always",
        status: "running",
        created_at: new Date("2026-08-15T12:00:00.000Z"),
        agent_config: {
          [AGENT_UPGRADED_FROM_KEY]: sourceAgentId,
          [AGENT_PERSONAL_CUTOVER_KEY]: cutoverFor(sourceAgentId),
        },
      })
      .returning();
    await dbWrite.insert(agentSandboxes).values({
      organization_id: account.organizationId,
      user_id: account.userId,
      execution_tier: "dedicated-always",
      status: "running",
      created_at: new Date("2026-08-15T12:01:00.000Z"),
      agent_config: { [AGENT_UPGRADED_FROM_KEY]: "personal:another-account" },
    });

    const query = spyOn(getPgliteClientForTests(), "query");
    const replayed = await elizaAppUserService.resolvePersonalDelivery(input);
    expect(query).toHaveBeenCalledTimes(2);
    query.mockRestore();
    expect(replayed.resolution).toBe("exact-dedicated-fallback");
    expect(replayed.dedicatedTarget?.id).toBe(exact.id);
  });

  test("repairs a stale projection through the sender-locked writer", async () => {
    const input = telegramInput("714700103");
    const account = await elizaAppUserService.resolvePersonalDelivery(input);
    await dbWrite
      .update(userIdentities)
      .set({ telegram_username: "stale_username" })
      .where(eq(userIdentities.user_id, account.userId));

    const repaired = await elizaAppUserService.resolvePersonalDelivery(input);
    expect(repaired.resolution).toBe("locked-create-or-repair");
    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, account.userId));
    expect(projection.telegram_username).toBe(input.username);
  });

  test("persists changed Telegram profile metadata through locked repair", async () => {
    const input = telegramInput("714700106");
    const account = await elizaAppUserService.resolvePersonalDelivery(input);

    const repaired = await elizaAppUserService.resolvePersonalDelivery({
      ...input,
      username: "renamed_user",
      firstName: "Luna",
    });
    expect(repaired).toMatchObject({
      userId: account.userId,
      organizationId: account.organizationId,
      resolution: "locked-create-or-repair",
    });
    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, account.userId));
    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, account.userId));
    expect(canonical.telegram_username).toBe("renamed_user");
    expect(canonical.telegram_first_name).toBe("Luna");
    expect(projection.telegram_username).toBe("renamed_user");
    expect(projection.telegram_first_name).toBe("Luna");
  });

  test("fails closed when the Telegram projection points at another tenant", async () => {
    const firstInput = telegramInput("714700107");
    const secondInput = telegramInput("714700108");
    const first = await elizaAppUserService.resolvePersonalDelivery(firstInput);
    const second = await elizaAppUserService.resolvePersonalDelivery(secondInput);
    const [secondBefore] = await dbWrite.select().from(users).where(eq(users.id, second.userId));

    await dbWrite.delete(userIdentities).where(eq(userIdentities.user_id, second.userId));
    await dbWrite
      .update(userIdentities)
      .set({ user_id: second.userId })
      .where(eq(userIdentities.user_id, first.userId));

    await expect(elizaAppUserService.resolvePersonalDelivery(firstInput)).rejects.toMatchObject({
      code: "TELEGRAM_PERSONAL_ACCOUNT_IDENTITY_CONFLICT",
    });

    const [secondAfter] = await dbWrite.select().from(users).where(eq(users.id, second.userId));
    const [conflictingProjection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.telegram_id, firstInput.telegramId));
    expect(secondAfter).toEqual(secondBefore);
    expect(conflictingProjection.user_id).toBe(second.userId);
    expect(first.organizationId).not.toBe(second.organizationId);
  });

  test("concurrent first contacts converge on one zero-credit account", async () => {
    const input = telegramInput("714700104");
    const [first, second] = await Promise.all([
      elizaAppUserService.resolvePersonalDelivery(input),
      elizaAppUserService.resolvePersonalDelivery(input),
    ]);

    expect(second.userId).toBe(first.userId);
    expect(second.organizationId).toBe(first.organizationId);
    const canonical = await dbWrite
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegram_id, input.telegramId));
    const projections = await dbWrite
      .select({ userId: userIdentities.user_id })
      .from(userIdentities)
      .where(eq(userIdentities.telegram_id, input.telegramId));
    const organization = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, first.organizationId));
    expect(canonical).toEqual([{ id: first.userId }]);
    expect(projections).toEqual([{ userId: first.userId }]);
    expect(organization).toHaveLength(1);
    expect(Number(organization[0]?.credit_balance)).toBe(0);
  });
});

describe("Phone personal Shared repeat delivery", () => {
  test("reuses one canonical Blooio/Twilio account in one statement", async () => {
    const input = phoneInput("+15557147001");
    const created = await elizaAppUserService.resolvePersonalDelivery(input);
    const [userBefore] = await dbWrite.select().from(users).where(eq(users.id, created.userId));
    const [projectionBefore] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, created.userId));

    const query = spyOn(getPgliteClientForTests(), "query");
    const replayed = await elizaAppUserService.resolvePersonalDelivery(input);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();

    const [userAfter] = await dbWrite.select().from(users).where(eq(users.id, created.userId));
    const [projectionAfter] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, created.userId));
    expect(replayed).toMatchObject({
      userId: created.userId,
      organizationId: created.organizationId,
      dedicatedTarget: null,
      isNew: false,
      resolution: "single-query-repeat",
    });
    expect(userAfter.updated_at).toEqual(userBefore.updated_at);
    expect(projectionAfter.updated_at).toEqual(projectionBefore.updated_at);
  });

  test("returns the exact authoritative Dedicated target for phone transports", async () => {
    const input = phoneInput("+15557147002");
    const account = await elizaAppUserService.resolvePersonalDelivery(input);
    const sourceAgentId = personalSharedAgentId({
      userId: account.userId,
      organizationId: account.organizationId,
    });
    const [target] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: account.organizationId,
        user_id: account.userId,
        execution_tier: "dedicated-always",
        status: "running",
        bridge_url: "http://127.0.0.1:9876/api/compat/agents/sandbox",
        agent_config: {
          [AGENT_UPGRADED_FROM_KEY]: sourceAgentId,
          [AGENT_PERSONAL_CUTOVER_KEY]: cutoverFor(sourceAgentId),
        },
      })
      .returning();

    const query = spyOn(getPgliteClientForTests(), "query");
    const replayed = await elizaAppUserService.resolvePersonalDelivery(input);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();
    expect(replayed.dedicatedTarget).toMatchObject({
      id: target.id,
      status: "running",
    });
  });
});

describe("Discord personal Shared repeat delivery", () => {
  test("reuses a converged account in one statement without rewriting identity rows", async () => {
    const input = discordInput("814700101");
    const created = await elizaAppUserService.resolvePersonalDelivery(input);
    const [userBefore] = await dbWrite.select().from(users).where(eq(users.id, created.userId));
    const [projectionBefore] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, created.userId));

    const query = spyOn(getPgliteClientForTests(), "query");
    const replayed = await elizaAppUserService.resolvePersonalDelivery(input);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockRestore();

    const [userAfter] = await dbWrite.select().from(users).where(eq(users.id, created.userId));
    const [projectionAfter] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, created.userId));
    expect(replayed).toMatchObject({
      userId: created.userId,
      organizationId: created.organizationId,
      dedicatedTarget: null,
      isNew: false,
      resolution: "single-query-repeat",
    });
    expect(userAfter.updated_at).toEqual(userBefore.updated_at);
    expect(projectionAfter.updated_at).toEqual(projectionBefore.updated_at);
  });

  test("preserves stored optional profile fields when the gateway omits them", async () => {
    const input = discordInput("814700107");
    const created = await elizaAppUserService.resolvePersonalDelivery(input);

    const replayed = await elizaAppUserService.resolvePersonalDelivery({
      platform: "discord",
      discordId: input.discordId,
      username: input.username,
    });

    expect(replayed).toMatchObject({
      userId: created.userId,
      organizationId: created.organizationId,
      resolution: "single-query-repeat",
    });
    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, created.userId));
    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, created.userId));
    expect(canonical).toMatchObject({
      discord_global_name: input.globalName,
      discord_avatar_url: input.avatarUrl,
    });
    expect(projection).toMatchObject({
      discord_global_name: input.globalName,
      discord_avatar_url: input.avatarUrl,
    });
  });

  test("returns exact Dedicated authority and falls back when another target is newer", async () => {
    const input = discordInput("814700102");
    const account = await elizaAppUserService.resolvePersonalDelivery(input);
    const sourceAgentId = personalSharedAgentId({
      userId: account.userId,
      organizationId: account.organizationId,
    });
    const [exact] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: account.organizationId,
        user_id: account.userId,
        execution_tier: "dedicated-always",
        status: "running",
        created_at: new Date("2026-08-15T12:00:00.000Z"),
        agent_config: {
          [AGENT_UPGRADED_FROM_KEY]: sourceAgentId,
          [AGENT_PERSONAL_CUTOVER_KEY]: cutoverFor(sourceAgentId),
        },
      })
      .returning();

    const directQuery = spyOn(getPgliteClientForTests(), "query");
    const direct = await elizaAppUserService.resolvePersonalDelivery(input);
    expect(directQuery).toHaveBeenCalledTimes(1);
    directQuery.mockRestore();
    expect(direct.dedicatedTarget?.id).toBe(exact.id);

    await dbWrite.insert(agentSandboxes).values({
      organization_id: account.organizationId,
      user_id: account.userId,
      execution_tier: "dedicated-always",
      status: "running",
      created_at: new Date("2026-08-15T12:01:00.000Z"),
      agent_config: { [AGENT_UPGRADED_FROM_KEY]: "personal:another-account" },
    });
    const fallbackQuery = spyOn(getPgliteClientForTests(), "query");
    const fallback = await elizaAppUserService.resolvePersonalDelivery(input);
    expect(fallbackQuery).toHaveBeenCalledTimes(2);
    fallbackQuery.mockRestore();
    expect(fallback.resolution).toBe("exact-dedicated-fallback");
    expect(fallback.dedicatedTarget?.id).toBe(exact.id);
  });

  test("repairs canonical-only and changed Discord profile projections atomically", async () => {
    const input = discordInput("814700103");
    const account = await elizaAppUserService.resolvePersonalDelivery(input);
    await dbWrite.delete(userIdentities).where(eq(userIdentities.user_id, account.userId));

    const repairedProjection = await elizaAppUserService.resolvePersonalDelivery(input);
    expect(repairedProjection.resolution).toBe("locked-create-or-repair");

    const changed = {
      ...input,
      username: "renamed_user",
      globalName: "Luna",
      avatarUrl: null,
    };
    const repairedProfile = await elizaAppUserService.resolvePersonalDelivery(changed);
    expect(repairedProfile.resolution).toBe("locked-create-or-repair");
    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, account.userId));
    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, account.userId));
    expect(canonical).toMatchObject({
      discord_username: "renamed_user",
      discord_global_name: "Luna",
      discord_avatar_url: null,
    });
    expect(projection).toMatchObject({
      discord_username: "renamed_user",
      discord_global_name: "Luna",
      discord_avatar_url: null,
    });
  });

  test("fails closed when the Discord projection points at another tenant", async () => {
    const firstInput = discordInput("814700104");
    const secondInput = discordInput("814700105");
    const first = await elizaAppUserService.resolvePersonalDelivery(firstInput);
    const second = await elizaAppUserService.resolvePersonalDelivery(secondInput);
    const [secondBefore] = await dbWrite.select().from(users).where(eq(users.id, second.userId));

    await dbWrite.delete(userIdentities).where(eq(userIdentities.user_id, second.userId));
    await dbWrite
      .update(userIdentities)
      .set({ user_id: second.userId })
      .where(eq(userIdentities.user_id, first.userId));

    await expect(elizaAppUserService.resolvePersonalDelivery(firstInput)).rejects.toMatchObject({
      code: "DISCORD_PERSONAL_ACCOUNT_IDENTITY_CONFLICT",
    });
    const [secondAfter] = await dbWrite.select().from(users).where(eq(users.id, second.userId));
    expect(secondAfter).toEqual(secondBefore);
    expect(first.organizationId).not.toBe(second.organizationId);
  });

  test("concurrent first contacts converge on one zero-cost account", async () => {
    const input = discordInput("814700106");
    const [first, second] = await Promise.all([
      elizaAppUserService.resolvePersonalDelivery(input),
      elizaAppUserService.resolvePersonalDelivery(input),
    ]);

    expect(second.userId).toBe(first.userId);
    expect(second.organizationId).toBe(first.organizationId);
    const canonical = await dbWrite
      .select({ id: users.id })
      .from(users)
      .where(eq(users.discord_id, input.discordId));
    const projections = await dbWrite
      .select({ userId: userIdentities.user_id })
      .from(userIdentities)
      .where(eq(userIdentities.discord_id, input.discordId));
    const organization = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, first.organizationId));
    expect(canonical).toEqual([{ id: first.userId }]);
    expect(projections).toEqual([{ userId: first.userId }]);
    expect(organization).toHaveLength(1);
    expect(Number(organization[0]?.credit_balance)).toBe(0);
    expect(await dbWrite.select().from(apiKeys)).toHaveLength(0);
    expect(await dbWrite.select().from(agentSandboxes)).toHaveLength(0);
  });
});
