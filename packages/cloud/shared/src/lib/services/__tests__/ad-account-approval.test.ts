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
  }
});
