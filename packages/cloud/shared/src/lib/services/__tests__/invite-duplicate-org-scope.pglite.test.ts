/** Drives the real InvitesService.createInvite on PGlite to prove the duplicate-invite guard is scoped to the inviting organization, even when another organization already has a pending invite for the same email. */

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error(
    "invite-duplicate-org-scope.pglite.test requires an isolated PGlite DATABASE_URL",
  );
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { and, eq } from "drizzle-orm";
import { organizationInvites } from "../../../db/schemas/organization-invites";
import { organizations } from "../../../db/schemas/organizations";
import { users } from "../../../db/schemas/users";

const TEST_TIMEOUT = 300_000;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let invitesService: typeof import("../invites").invitesService;
let emailService: typeof import("../email").emailService;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  ({ invitesService } = await import("../invites"));
  ({ emailService } = await import("../email"));
  const { apply } = await pushSchema(
    { organizations, users, organizationInvites } as never,
    dbWrite as never,
  );
  await apply();
}, TEST_TIMEOUT);

afterAll(async () => {
  await closeDb();
});

async function seedOrgWithInviter(slug: string) {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: slug, slug })
    .returning();
  const [inviter] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: `steward-${slug}`,
      email: `owner@${slug}.test`,
      name: `Owner ${slug}`,
      organization_id: organization.id,
      role: "owner",
    })
    .returning();
  return { orgId: organization.id, inviterId: inviter.id };
}

test(
  "a second invite to the same email is rejected even when another org has a pending invite",
  async () => {
    const sendInvite = spyOn(emailService, "sendInviteEmail").mockResolvedValue(true);
    const orgA = await seedOrgWithInviter("org-a");
    const orgB = await seedOrgWithInviter("org-b");
    const email = "bob@example.test";

    await invitesService.createInvite({
      organizationId: orgB.orgId,
      inviterUserId: orgB.inviterId,
      invitedEmail: email,
      invitedRole: "member",
    });
    await invitesService.createInvite({
      organizationId: orgA.orgId,
      inviterUserId: orgA.inviterId,
      invitedEmail: email,
      invitedRole: "member",
    });

    await expect(
      invitesService.createInvite({
        organizationId: orgA.orgId,
        inviterUserId: orgA.inviterId,
        invitedEmail: "Bob@Example.test",
        invitedRole: "admin",
      }),
    ).rejects.toThrow("An invite for this email is already pending");

    const pendingForA = await dbWrite
      .select()
      .from(organizationInvites)
      .where(
        and(
          eq(organizationInvites.organization_id, orgA.orgId),
          eq(organizationInvites.status, "pending"),
        ),
      );
    expect(pendingForA).toHaveLength(1);
    expect(sendInvite).toHaveBeenCalledTimes(2);
    sendInvite.mockRestore();
  },
  TEST_TIMEOUT,
);
