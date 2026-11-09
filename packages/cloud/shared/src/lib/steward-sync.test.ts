/**
 * Email-based account linking in Steward sign-in: an address a user set on
 * their own (PATCH /api/v1/user/email, stored unverified) must never hand a
 * proven sign-in for that address over to their account.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

process.env.MOCK_REDIS = "1";

const { organizationInvitesRepository } = await import("../db/repositories/organization-invites");
const { usersRepository } = await import("../db/repositories/users");
const { apiKeysService } = await import("./services/api-keys");
const { charactersService } = await import("./services/characters");
const { discordService } = await import("./services/discord");
const { emailService } = await import("./services/email");
const { invitesService } = await import("./services/invites");
const { organizationsService } = await import("./services/organizations");
const stewardTenantConfig = await import("./services/steward-tenant-config");
const { usersService } = await import("./services/users");
const { syncUserFromSteward } = await import("./steward-sync");

type Row = {
  id: string;
  steward_user_id: string | null;
  email: string | null;
  email_verified: boolean;
  name: string | null;
  organization_id: string;
  wallet_address: string | null;
  wallet_verified: boolean;
  role: string;
};

const VICTIM = "victim@example.com";
let rows: Row[];
let organizations: Set<string>;
let nextId: number;
let pendingInvite: { id: string; organization_id: string; invited_role: string } | undefined;
let beforeFreshInsert: (() => void) | undefined;
let freshInsertError: Error | undefined;
const spies: ReturnType<typeof spyOn>[] = [];

function withOrg(row: Row | undefined) {
  if (!row) return undefined;
  return {
    ...row,
    organization: { id: row.organization_id, name: "Org", is_active: true },
  } as never;
}

function uniqueViolation(): Error {
  return Object.assign(new Error("duplicate key"), { code: "23505" });
}

function insert(data: Record<string, unknown>): Row {
  if (data.email && rows.some((row) => row.email === data.email)) throw uniqueViolation();
  if (rows.some((row) => row.steward_user_id === data.steward_user_id)) throw uniqueViolation();
  const row: Row = {
    id: `user-${nextId++}`,
    steward_user_id: data.steward_user_id as string,
    email: (data.email as string | null) ?? null,
    email_verified: Boolean(data.email_verified),
    name: (data.name as string | null) ?? null,
    organization_id: data.organization_id as string,
    wallet_address: null,
    wallet_verified: false,
    role: (data.role as string) ?? "owner",
  };
  rows.push(row);
  return row;
}

function addRow(row: Partial<Row> & Pick<Row, "steward_user_id">): Row {
  const full: Row = {
    id: `user-${nextId++}`,
    email: null,
    email_verified: false,
    name: "Existing",
    organization_id: `org-${nextId++}`,
    wallet_address: null,
    wallet_verified: false,
    role: "owner",
    ...row,
  };
  organizations.add(full.organization_id);
  rows.push(full);
  return full;
}

beforeEach(() => {
  rows = [];
  organizations = new Set();
  nextId = 1;
  pendingInvite = undefined;
  beforeFreshInsert = undefined;
  freshInsertError = undefined;
  const byEmail = async (email: string) => withOrg(rows.find((row) => row.email === email));
  spies.push(
    spyOn(usersRepository, "findPendingPhoneTelegramPersonalAccountConvergence").mockImplementation(
      (async ({ stewardUserId }: { stewardUserId: string }) => {
        const row = rows.find((candidate) => candidate.steward_user_id === stewardUserId);
        return row ? { status: "canonical_user", user: withOrg(row) } : { status: "not_found" };
      }) as never,
    ),
    spyOn(usersService, "getByStewardIdForWrite").mockImplementation(async (stewardUserId) =>
      withOrg(rows.find((row) => row.steward_user_id === stewardUserId)),
    ),
    spyOn(usersService, "getByEmailWithOrganization").mockImplementation(byEmail),
    spyOn(usersService, "update").mockImplementation(async (id, data) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return undefined;
      Object.assign(row, data);
      return row as never;
    }),
    spyOn(usersService, "clearUnverifiedEmail").mockImplementation(async (user, email) => {
      const row = rows.find((candidate) => candidate.id === user.id);
      if (!row || row.email !== email || row.email_verified) return false;
      row.email = null;
      return true;
    }),
    spyOn(usersService, "upsertStewardIdentity").mockResolvedValue(undefined),
    spyOn(usersService, "initializeFreshStewardIdentity").mockResolvedValue(undefined),
    spyOn(usersService, "create").mockImplementation(async (data) => insert(data) as never),
    spyOn(usersService, "createFreshStewardSignupUser").mockImplementation(async (data) => {
      beforeFreshInsert?.();
      beforeFreshInsert = undefined;
      if (freshInsertError) throw freshInsertError;
      return insert(data) as never;
    }),
    spyOn(invitesService, "findPendingInviteByEmail").mockImplementation(
      async () => pendingInvite as never,
    ),
    spyOn(organizationInvitesRepository, "markAsAccepted").mockImplementation(
      async () => pendingInvite as never,
    ),
    spyOn(organizationsService, "create").mockImplementation(async (data) => {
      const id = `org-${nextId++}`;
      organizations.add(id);
      return { id, name: data.name, slug: data.slug, is_active: true } as never;
    }),
    spyOn(organizationsService, "delete").mockImplementation(async (id) => {
      organizations.delete(id);
    }),
    spyOn(apiKeysService, "provisionDefaultApiKey").mockResolvedValue(undefined as never),
    spyOn(charactersService, "hasHealthyCloudCharacterMirror").mockResolvedValue(true),
    spyOn(stewardTenantConfig, "ensureStewardTenant").mockResolvedValue(undefined as never),
    spyOn(emailService, "sendWelcomeEmail").mockResolvedValue(undefined as never),
    spyOn(discordService, "logUserSignup").mockResolvedValue(undefined as never),
  );
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("an unverified self-set address does not capture the owner's sign-in", async () => {
  const attacker = addRow({ steward_user_id: "steward-attacker", email: VICTIM });

  const user = await syncUserFromSteward({ stewardUserId: "steward-victim", email: VICTIM });

  expect(user.id).not.toBe(attacker.id);
  expect(user.accountCreated).toBe(true);
  expect(user.email).toBe(VICTIM);
  expect(attacker.email).toBeNull();
  expect(attacker.steward_user_id).toBe("steward-attacker");
});

test("an address set between the lookup and the insert is not linked", async () => {
  const attacker = addRow({ steward_user_id: "steward-attacker" });
  beforeFreshInsert = () => {
    attacker.email = VICTIM;
  };

  const user = await syncUserFromSteward({ stewardUserId: "steward-victim", email: VICTIM });

  expect(user.id).not.toBe(attacker.id);
  expect(attacker.steward_user_id).toBe("steward-attacker");
  expect(attacker.email).toBeNull();
  expect(user.email).toBe(VICTIM);
});

test("a squat that survives the clear fails the sign-in without linking", async () => {
  const attacker = addRow({ steward_user_id: "steward-attacker" });
  const insertSpy = usersService.createFreshStewardSignupUser as unknown as {
    mockImplementation: (fn: () => Promise<never>) => void;
  };
  insertSpy.mockImplementation(async () => {
    attacker.email = VICTIM;
    throw uniqueViolation();
  });

  await expect(
    syncUserFromSteward({ stewardUserId: "steward-victim", email: VICTIM }),
  ).rejects.toMatchObject({ code: "STEWARD_EMAIL_CLAIM_CONFLICT" });
  expect(attacker.steward_user_id).toBe("steward-attacker");
  expect([...organizations]).toEqual([attacker.organization_id]);
});

test("a verified address still links the existing account", async () => {
  const existing = addRow({
    steward_user_id: "steward-old",
    email: VICTIM,
    email_verified: true,
  });

  const user = await syncUserFromSteward({ stewardUserId: "steward-new", email: VICTIM });

  expect(user.id).toBe(existing.id);
  expect(existing.steward_user_id).toBe("steward-new");
  expect(existing.email).toBe(VICTIM);
});

test("an iMessage-created email:<addr> account is promoted", async () => {
  const synthetic = addRow({ steward_user_id: `email:${VICTIM}`, email: VICTIM });

  const user = await syncUserFromSteward({ stewardUserId: "steward-victim", email: VICTIM });

  expect(user.id).toBe(synthetic.id);
  expect(synthetic.steward_user_id).toBe("steward-victim");
});

test("an invited sign-up is not blocked by an unverified squat", async () => {
  const attacker = addRow({ steward_user_id: "steward-attacker", email: VICTIM });
  organizations.add("org-inviting");
  pendingInvite = { id: "invite-1", organization_id: "org-inviting", invited_role: "member" };

  const user = await syncUserFromSteward({ stewardUserId: "steward-victim", email: VICTIM });

  expect(user.id).not.toBe(attacker.id);
  expect(user.organization_id).toBe("org-inviting");
  expect(user.role).toBe("member");
  expect(attacker.email).toBeNull();
});

test("a stored name survives a sign-in that does not carry one", async () => {
  const existing = addRow({
    steward_user_id: "steward-a",
    email: VICTIM,
    email_verified: true,
    name: "Chosen Name",
  });

  await syncUserFromSteward({ stewardUserId: "steward-a", email: VICTIM });
  expect(existing.name).toBe("Chosen Name");

  await syncUserFromSteward({ stewardUserId: "steward-a", email: VICTIM, name: "Provider Name" });
  expect(existing.name).toBe("Provider Name");
});

test("a sign-in without email or name changes does not rewrite the user", async () => {
  addRow({ steward_user_id: "steward-a", name: "Chosen Name" });

  await syncUserFromSteward({ stewardUserId: "steward-a" });

  expect(usersService.update).not.toHaveBeenCalled();
});

test("a failed user insert leaves no orphan organization", async () => {
  freshInsertError = new Error("insert failed");

  await expect(
    syncUserFromSteward({ stewardUserId: "steward-new", email: VICTIM }),
  ).rejects.toThrow("insert failed");
  expect(organizations.size).toBe(0);
});
