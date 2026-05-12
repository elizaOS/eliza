import { beforeEach, describe, expect, test } from "bun:test";
import { organizationInvitesRepository } from "@/db/repositories/organization-invites";
import { apiKeysService } from "@/lib/services/api-keys";
import { charactersService } from "@/lib/services/characters/characters";
import { creditsService } from "@/lib/services/credits";
import { discordService } from "@/lib/services/discord";
import { emailService } from "@/lib/services/email";
import { invitesService } from "@/lib/services/invites";
import { organizationsService } from "@/lib/services/organizations";
import { usersService } from "@/lib/services/users";
import { syncUserFromSteward } from "@/lib/steward-sync";
import type { UserWithOrganization } from "@/lib/types";

const BASE_ORG = {
  id: "org-1",
  name: "Existing Org",
  slug: "existing-org",
  billing_email: null,
};

describe("syncUserFromSteward", () => {
  beforeEach(() => {
    usersService.getByStewardId = (async () =>
      undefined) as unknown as typeof usersService.getByStewardId;
    usersService.getByStewardIdForWrite = (async () =>
      undefined) as unknown as typeof usersService.getByStewardIdForWrite;
    usersService.getByEmailWithOrganization = (async () =>
      undefined) as unknown as typeof usersService.getByEmailWithOrganization;
    usersService.getByWalletAddress = (async () =>
      undefined) as unknown as typeof usersService.getByWalletAddress;
    usersService.getByWalletAddressWithOrganization = (async () =>
      undefined) as unknown as typeof usersService.getByWalletAddressWithOrganization;
    usersService.create = (async (data: Parameters<typeof usersService.create>[0]) => ({
      id: "created-user",
      ...data,
    })) as unknown as typeof usersService.create;
    usersService.update = (async (
      id: Parameters<typeof usersService.update>[0],
      data: Parameters<typeof usersService.update>[1],
    ) => ({
      id,
      ...data,
    })) as unknown as typeof usersService.update;
    usersService.linkStewardId = (async () => {}) as unknown as typeof usersService.linkStewardId;
    usersService.upsertStewardIdentity =
      (async () => {}) as unknown as typeof usersService.upsertStewardIdentity;

    invitesService.findPendingInviteByEmail = (async () =>
      undefined) as unknown as typeof invitesService.findPendingInviteByEmail;
    organizationInvitesRepository.markAsAccepted =
      (async () => {}) as unknown as typeof organizationInvitesRepository.markAsAccepted;

    organizationsService.getBySlug = (async () =>
      undefined) as unknown as typeof organizationsService.getBySlug;
    organizationsService.create = (async (
      data: Parameters<typeof organizationsService.create>[0],
    ) => ({
      id: "new-org",
      billing_email: null,
      ...data,
    })) as unknown as typeof organizationsService.create;
    organizationsService.update = (async (
      id: Parameters<typeof organizationsService.update>[0],
      data: Parameters<typeof organizationsService.update>[1],
    ) => ({
      id,
      ...data,
    })) as unknown as typeof organizationsService.update;
    organizationsService.delete = (async () => {}) as unknown as typeof organizationsService.delete;

    creditsService.addCredits = (async () => {}) as unknown as typeof creditsService.addCredits;
    emailService.sendWelcomeEmail =
      (async () => {}) as unknown as typeof emailService.sendWelcomeEmail;
    discordService.logUserSignup =
      (async () => {}) as unknown as typeof discordService.logUserSignup;
    apiKeysService.listByOrganization =
      (async () => []) as unknown as typeof apiKeysService.listByOrganization;
    apiKeysService.create = (async () => ({
      id: "api-key-1",
    })) as unknown as typeof apiKeysService.create;
    charactersService.listByOrganization =
      (async () => []) as unknown as typeof charactersService.listByOrganization;
    charactersService.create = (async () => ({
      id: "char-1",
    })) as unknown as typeof charactersService.create;
  });

  test("links an existing wallet user for wallet-only Steward sessions", async () => {
    const existingUser = {
      id: "user-wallet-existing",
      steward_user_id: null,
      email: null,
      email_verified: false,
      wallet_address: "0xabc123",
      wallet_chain_type: "ethereum",
      role: "owner",
      organization_id: BASE_ORG.id,
      is_active: true,
    };
    const linkedUser = {
      ...existingUser,
      steward_user_id: "stwd-wallet-1",
      organization: BASE_ORG,
    } as UserWithOrganization;

    let linked = false;
    let upserted = false;

    usersService.getByWalletAddress = (async (address: string) => {
      expect(address).toBe("0xabc123");
      return existingUser;
    }) as unknown as typeof usersService.getByWalletAddress;
    usersService.linkStewardId = (async (
      userId: Parameters<typeof usersService.linkStewardId>[0],
      stewardUserId: Parameters<typeof usersService.linkStewardId>[1],
    ) => {
      expect(userId).toBe(existingUser.id);
      expect(stewardUserId).toBe("stwd-wallet-1");
      linked = true;
    }) as unknown as typeof usersService.linkStewardId;
    usersService.upsertStewardIdentity = (async (
      userId: Parameters<typeof usersService.upsertStewardIdentity>[0],
      stewardUserId: Parameters<typeof usersService.upsertStewardIdentity>[1],
    ) => {
      expect(userId).toBe(existingUser.id);
      expect(stewardUserId).toBe("stwd-wallet-1");
      upserted = true;
    }) as unknown as typeof usersService.upsertStewardIdentity;
    usersService.getByStewardIdForWrite = (async (
      stewardUserId: Parameters<typeof usersService.getByStewardIdForWrite>[0],
    ) => {
      expect(stewardUserId).toBe("stwd-wallet-1");
      return linkedUser;
    }) as unknown as typeof usersService.getByStewardIdForWrite;
    usersService.create = (async () => {
      throw new Error("create should not run when wallet match exists");
    }) as unknown as typeof usersService.create;

    const result = await syncUserFromSteward({
      stewardUserId: "stwd-wallet-1",
      walletAddress: "0xAbC123",
    });

    expect(result).toEqual(linkedUser);
    expect(linked).toBe(true);
    expect(upserted).toBe(true);
  });

  test("creates a new wallet-only user when no wallet match exists", async () => {
    let createdPayload: Parameters<typeof usersService.create>[0] | undefined;
    const createdUser = {
      id: "wallet-new-user",
      steward_user_id: "stwd-wallet-2",
      email: null,
      email_verified: false,
      wallet_address: "0xdef456",
      wallet_chain_type: "ethereum",
      wallet_verified: true,
      role: "owner",
      organization_id: "new-org",
      is_active: true,
    };
    const createdUserWithOrg = {
      ...createdUser,
      organization: {
        id: "new-org",
        name: "0xdef4...f456's Organization",
        slug: "wallet-0xdef456-test",
        billing_email: null,
      },
    } as UserWithOrganization;

    organizationsService.create = (async (
      data: Parameters<typeof organizationsService.create>[0],
    ) => ({
      id: "new-org",
      billing_email: null,
      ...data,
    })) as unknown as typeof organizationsService.create;
    usersService.create = (async (data: Parameters<typeof usersService.create>[0]) => {
      createdPayload = data;
      return { id: "wallet-new-user", ...data };
    }) as unknown as typeof usersService.create;
    usersService.getByStewardIdForWrite = (async () =>
      createdUserWithOrg) as unknown as typeof usersService.getByStewardIdForWrite;

    const result = await syncUserFromSteward({
      stewardUserId: "stwd-wallet-2",
      walletAddress: "0xDeF456",
    });

    expect(result).toEqual(createdUserWithOrg);
    expect(createdPayload?.wallet_address).toBe("0xdef456");
    expect(createdPayload?.wallet_chain_type).toBe("ethereum");
    expect(createdPayload?.wallet_verified).toBe(true);
    expect(createdPayload?.email).toBeNull();
  });

  test("still links existing email users without breaking the legacy path", async () => {
    const existingByEmail = {
      id: "user-email-existing",
      steward_user_id: null,
      email: "shadow@example.com",
      email_verified: true,
      wallet_address: null,
      wallet_chain_type: null,
      role: "owner",
      organization_id: BASE_ORG.id,
      is_active: true,
      organization: BASE_ORG,
    };
    const linkedUser = {
      ...existingByEmail,
      steward_user_id: "stwd-email-1",
    } as UserWithOrganization;

    let updatedPayload: Parameters<typeof usersService.update>[1] | undefined;

    usersService.getByEmailWithOrganization = (async (email: string) => {
      expect(email).toBe("shadow@example.com");
      return existingByEmail;
    }) as unknown as typeof usersService.getByEmailWithOrganization;
    usersService.update = (async (
      id: Parameters<typeof usersService.update>[0],
      data: Parameters<typeof usersService.update>[1],
    ) => {
      expect(id).toBe(existingByEmail.id);
      updatedPayload = data;
      return { ...existingByEmail, ...data };
    }) as unknown as typeof usersService.update;
    usersService.upsertStewardIdentity = (async (
      userId: Parameters<typeof usersService.upsertStewardIdentity>[0],
      stewardUserId: Parameters<typeof usersService.upsertStewardIdentity>[1],
    ) => {
      expect(userId).toBe(existingByEmail.id);
      expect(stewardUserId).toBe("stwd-email-1");
    }) as unknown as typeof usersService.upsertStewardIdentity;
    usersService.getByStewardIdForWrite = (async (
      stewardUserId: Parameters<typeof usersService.getByStewardIdForWrite>[0],
    ) => {
      expect(stewardUserId).toBe("stwd-email-1");
      return linkedUser;
    }) as unknown as typeof usersService.getByStewardIdForWrite;

    const result = await syncUserFromSteward({
      stewardUserId: "stwd-email-1",
      email: "Shadow@Example.com",
    });

    expect(result).toEqual(linkedUser);
    expect(updatedPayload?.steward_user_id).toBe("stwd-email-1");
  });
});
