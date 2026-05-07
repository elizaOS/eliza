/**
 * Regression test: Steward lookup hydration remains compatible with the
 * relational Drizzle query shape used throughout the user auth flow.
 *
 * These assertions intentionally read from primary because they verify the
 * post-write hydrated shape, not replica propagation timing.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { dbWrite } from "@/db/helpers";
import { users } from "@/db/schemas/users";
import { usersService } from "@/lib/services/users";
import { getConnectionString } from "@/tests/helpers/local-database";
import {
  cleanupTestData,
  createTestDataSet,
  type TestDataSet,
} from "@/tests/helpers/test-data-factory";

describe("Steward read-path regression (5c31c7732)", () => {
  let connectionString: string;
  let testData: TestDataSet;
  let detachedUserId: string | undefined;

  beforeAll(async () => {
    connectionString = getConnectionString();
  });

  beforeEach(async () => {
    detachedUserId = undefined;
    testData = await createTestDataSet(connectionString, {
      creditBalance: 100,
    });
  });

  afterEach(async () => {
    if (detachedUserId) {
      await usersService.delete(detachedUserId);
      detachedUserId = undefined;
    }

    if (testData?.organization?.id) {
      await cleanupTestData(connectionString, testData.organization.id);
    }
  });

  test("getByStewardId returns organization numeric fields matching relational query format", async () => {
    const stewardId = `steward_${uuidv4()}`;

    await usersService.update(testData.user.id, { steward_user_id: stewardId });
    await usersService.upsertStewardIdentity(testData.user.id, stewardId);

    const serviceUser = await usersService.getByStewardIdForWrite(stewardId);
    expect(serviceUser).toBeDefined();

    const relationalUser = await dbWrite.query.users.findFirst({
      where: eq(users.id, testData.user.id),
      with: { organization: true },
    });
    expect(relationalUser).toBeDefined();

    expect(serviceUser!.id).toBe(relationalUser!.id);
    expect(serviceUser!.email).toBe(relationalUser!.email);
    expect(serviceUser!.steward_user_id).toBe(relationalUser!.steward_user_id);
    expect(serviceUser!.organization_id).toBe(relationalUser!.organization_id);

    const serviceOrg = serviceUser!.organization!;
    const relationalOrgRaw = relationalUser!.organization;
    if (relationalOrgRaw == null || Array.isArray(relationalOrgRaw)) {
      throw new Error("expected single organization relation");
    }
    const relationalOrg = relationalOrgRaw;
    expect(serviceOrg.credit_balance).toBe(relationalOrg.credit_balance);
    expect(serviceOrg.id).toBe(relationalOrg.id);
    expect(serviceOrg.name).toBe(relationalOrg.name);
    expect(serviceOrg.slug).toBe(relationalOrg.slug);

    const serviceKeys = Object.keys(serviceUser!).sort();
    const relationalKeys = Object.keys(relationalUser!).sort();
    expect(serviceKeys).toEqual(relationalKeys);
  });

  test("getByStewardId returns null organization when organization_id is null", async () => {
    const stewardId = `steward_${uuidv4()}`;

    const detachedUser = await usersService.create({
      email: `detached-${uuidv4().slice(0, 8)}@test.local`,
      name: "Detached User",
      organization_id: null,
      role: "member",
      is_anonymous: false,
      is_active: true,
      steward_user_id: stewardId,
    });
    detachedUserId = detachedUser.id;

    await usersService.upsertStewardIdentity(detachedUser.id, stewardId);

    const serviceUser = await usersService.getByStewardIdForWrite(stewardId);
    expect(serviceUser).toBeDefined();
    expect(serviceUser!.id).toBe(detachedUser.id);
    expect(serviceUser!.organization_id).toBeNull();
    expect(serviceUser!.organization).toBeNull();

    const relationalUser = await dbWrite.query.users.findFirst({
      where: eq(users.id, detachedUser.id),
      with: { organization: true },
    });
    expect(relationalUser).toBeDefined();
    expect(relationalUser!.organization_id).toBeNull();
    expect(relationalUser!.organization).toBeNull();
  });

  test("getByStewardId returns same org fields used by /api/v1/user route", async () => {
    const stewardId = `steward_${uuidv4()}`;

    await usersService.update(testData.user.id, { steward_user_id: stewardId });
    await usersService.upsertStewardIdentity(testData.user.id, stewardId);

    const user = await usersService.getByStewardIdForWrite(stewardId);
    expect(user).toBeDefined();

    expect(user!.id).toBeDefined();
    expect(user!.email).toBeDefined();
    expect(user!.role).toBeDefined();
    expect(user!.is_active).toBeDefined();
    expect(user!.created_at).toBeDefined();
    expect(user!.updated_at).toBeDefined();

    expect(user!.organization).toBeDefined();
    expect(user!.organization!.id).toBeDefined();
    expect(user!.organization!.name).toBeDefined();
    expect(user!.organization!.slug).toBeDefined();
    expect(user!.organization!.credit_balance).toBeDefined();
  });
});
