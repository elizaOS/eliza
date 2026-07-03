/**
 * Ad-account approval gate + campaign status enforcement (#11364).
 *
 * Ad spend is money movement, so before this fix any connected ad account was
 * immediately "active" and campaigns never checked account status — a stolen or
 * abusive account could spend with zero review, and a suspended account's
 * campaigns could still be created/started. This locks it down:
 *
 *  - connectAccount now creates accounts "pending" (asserted in the connect flow
 *    tests; here we cover the state machine + enforcement directly).
 *  - approveAccount (pending→active) / rejectAccount (→suspended) are the
 *    platform-operator transitions (requireAdmin at the route — an org owner can
 *    never self-approve, same posture as fiat payouts).
 *  - createCampaign and startCampaign refuse any account whose status !== "active".
 *
 * Tests the REAL advertisingService; only the repository boundary is spied
 * (no `mock.module`, so nothing leaks).
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { adAccountsRepository, adCampaignsRepository } from "../../../db/repositories";
import type { AdAccount, AdAccountStatus } from "../../../db/schemas/ad-accounts";
import { advertisingService } from "../advertising";
import { creditsService } from "../credits";

const ORG_ID = "org-1";
const ACCOUNT_ID = "acct-1";
const CAMPAIGN_ID = "campaign-1";

const spies: Array<{ mockRestore: () => void }> = [];
function track<T extends { mockRestore: () => void }>(s: T): T {
  spies.push(s);
  return s;
}

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

function makeAccount(status: AdAccountStatus): AdAccount {
  return {
    id: ACCOUNT_ID,
    organization_id: ORG_ID,
    connected_by_user_id: "user-1",
    platform: "meta",
    external_account_id: "ext-1",
    account_name: "Acct",
    access_token_secret_id: "sec-1",
    refresh_token_secret_id: null,
    status,
    spend_cap_credits: null,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
  } as unknown as AdAccount;
}

function makeCampaign(over: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN_ID,
    organization_id: ORG_ID,
    ad_account_id: ACCOUNT_ID,
    name: "My Campaign",
    external_campaign_id: "ext-camp-1",
    ...over,
  } as never;
}

describe("approveAccount (#11364)", () => {
  test("pending → active, persisted via updateStatus", async () => {
    track(spyOn(adAccountsRepository, "findById").mockResolvedValue(makeAccount("pending")));
    const update = track(
      spyOn(adAccountsRepository, "updateStatus").mockResolvedValue(makeAccount("active")),
    );

    const result = await advertisingService.approveAccount(ACCOUNT_ID);

    expect(result.status).toBe("active");
    expect(update).toHaveBeenCalledWith(ACCOUNT_ID, "active");
  });

  test("is idempotent on an already-active account (no write)", async () => {
    track(spyOn(adAccountsRepository, "findById").mockResolvedValue(makeAccount("active")));
    const update = track(spyOn(adAccountsRepository, "updateStatus").mockResolvedValue(undefined));

    const result = await advertisingService.approveAccount(ACCOUNT_ID);

    expect(result.status).toBe("active");
    expect(update).not.toHaveBeenCalled();
  });

  test("refuses to approve from a non-pending status (e.g. suspended)", async () => {
    track(spyOn(adAccountsRepository, "findById").mockResolvedValue(makeAccount("suspended")));
    const update = track(spyOn(adAccountsRepository, "updateStatus").mockResolvedValue(undefined));

    await expect(advertisingService.approveAccount(ACCOUNT_ID)).rejects.toThrow(/only "pending"/);
    expect(update).not.toHaveBeenCalled();
  });

  test("throws on unknown account", async () => {
    track(spyOn(adAccountsRepository, "findById").mockResolvedValue(undefined));
    await expect(advertisingService.approveAccount(ACCOUNT_ID)).rejects.toThrow(/not found/);
  });
});

describe("rejectAccount (#11364)", () => {
  test("active → suspended, persisted", async () => {
    track(spyOn(adAccountsRepository, "findById").mockResolvedValue(makeAccount("active")));
    const update = track(
      spyOn(adAccountsRepository, "updateStatus").mockResolvedValue(makeAccount("suspended")),
    );

    const result = await advertisingService.rejectAccount(ACCOUNT_ID);

    expect(result.status).toBe("suspended");
    expect(update).toHaveBeenCalledWith(ACCOUNT_ID, "suspended");
  });

  test("is idempotent on an already-suspended account (no write)", async () => {
    track(spyOn(adAccountsRepository, "findById").mockResolvedValue(makeAccount("suspended")));
    const update = track(spyOn(adAccountsRepository, "updateStatus").mockResolvedValue(undefined));

    const result = await advertisingService.rejectAccount(ACCOUNT_ID);

    expect(result.status).toBe("suspended");
    expect(update).not.toHaveBeenCalled();
  });
});

describe("campaign spend requires an approved (active) account (#11364)", () => {
  for (const status of ["pending", "suspended", "disconnected"] as AdAccountStatus[]) {
    test(`createCampaign is blocked when account is ${status}`, async () => {
      track(spyOn(adAccountsRepository, "findById").mockResolvedValue(makeAccount(status)));

      await expect(
        advertisingService.createCampaign({
          organizationId: ORG_ID,
          adAccountId: ACCOUNT_ID,
          name: "Campaign",
          budgetAmount: 100,
        } as never),
      ).rejects.toThrow(/not active/);
    });

    test(`startCampaign is blocked when account is ${status}`, async () => {
      track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(makeCampaign()));
      track(spyOn(adAccountsRepository, "findById").mockResolvedValue(makeAccount(status)));

      await expect(advertisingService.startCampaign(CAMPAIGN_ID, ORG_ID)).rejects.toThrow(
        /not active/,
      );
    });

    test(`updateCampaign is blocked when account is ${status} (no budget-increase spend)`, async () => {
      track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(makeCampaign()));
      track(spyOn(adAccountsRepository, "findById").mockResolvedValue(makeAccount(status)));

      await expect(
        advertisingService.updateCampaign(CAMPAIGN_ID, ORG_ID, { budgetAmount: 10_000 }),
      ).rejects.toThrow(/not active/);
    });
  }
});

describe("spend caps (#11364)", () => {
  test("setAccountSpendCap rejects lowering below already allocated campaign exposure", async () => {
    track(spyOn(adAccountsRepository, "findById").mockResolvedValue(makeAccount("active")));
    track(spyOn(adCampaignsRepository, "sumCreditsAllocatedByAdAccount").mockResolvedValue(75));
    const update = track(spyOn(adAccountsRepository, "update").mockResolvedValue(undefined));

    await expect(advertisingService.setAccountSpendCap(ACCOUNT_ID, ORG_ID, 50)).rejects.toThrow(
      /already has 75.00 allocated credits/,
    );

    expect(update).not.toHaveBeenCalled();
  });

  test("setAccountSpendCap persists a nullable cap for an org-owned account", async () => {
    track(spyOn(adAccountsRepository, "findById").mockResolvedValue(makeAccount("active")));
    track(spyOn(adCampaignsRepository, "sumCreditsAllocatedByAdAccount").mockResolvedValue(25));
    const update = track(
      spyOn(adAccountsRepository, "update").mockResolvedValue({
        ...makeAccount("active"),
        spend_cap_credits: "50.00",
      }),
    );

    const account = await advertisingService.setAccountSpendCap(ACCOUNT_ID, ORG_ID, 50);

    expect(account.spend_cap_credits).toBe("50.00");
    expect(update).toHaveBeenCalledWith(ACCOUNT_ID, { spend_cap_credits: "50.00" });
  });

  test("createCampaign rejects a campaign cap below the marked-up budget before credit debit", async () => {
    track(spyOn(adAccountsRepository, "findById").mockResolvedValue(makeAccount("active")));
    const debit = track(
      spyOn(creditsService, "deductCredits").mockResolvedValue({ success: true } as never),
    );

    await expect(
      advertisingService.createCampaign({
        organizationId: ORG_ID,
        adAccountId: ACCOUNT_ID,
        name: "Campaign",
        objective: "traffic",
        budgetType: "lifetime",
        budgetAmount: 100,
        spendCapCredits: 50,
      }),
    ).rejects.toThrow(/Campaign spend cap would be exceeded/);

    expect(debit).not.toHaveBeenCalled();
  });

  test("createCampaign rejects an account cap breach before credit debit", async () => {
    track(
      spyOn(adAccountsRepository, "findById").mockResolvedValue({
        ...makeAccount("active"),
        spend_cap_credits: "120.00",
      }),
    );
    track(spyOn(adCampaignsRepository, "sumCreditsAllocatedByAdAccount").mockResolvedValue(60));
    const debit = track(
      spyOn(creditsService, "deductCredits").mockResolvedValue({ success: true } as never),
    );

    await expect(
      advertisingService.createCampaign({
        organizationId: ORG_ID,
        adAccountId: ACCOUNT_ID,
        name: "Campaign",
        objective: "traffic",
        budgetType: "lifetime",
        budgetAmount: 100,
      }),
    ).rejects.toThrow(/Ad account spend cap would be exceeded/);

    expect(debit).not.toHaveBeenCalled();
  });

  test("updateCampaign persists a cap-only update on an unsynced campaign", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({
          external_campaign_id: null,
          credits_allocated: "10.00",
          spend_cap_credits: null,
          metadata: {},
        }),
      ),
    );
    const update = track(
      spyOn(adCampaignsRepository, "update").mockResolvedValue(
        makeCampaign({ spend_cap_credits: "25.00" }),
      ),
    );

    const campaign = await advertisingService.updateCampaign(CAMPAIGN_ID, ORG_ID, {
      spendCapCredits: 25,
    });

    expect(campaign.spend_cap_credits).toBe("25.00");
    expect(update).toHaveBeenCalledWith(CAMPAIGN_ID, {
      metadata: {},
      spend_cap_credits: "25.00",
    });
  });
});
