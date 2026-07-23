/**
 * Fail-closed coverage for credit-balance READ paths (#12268 fallback-slop sweep).
 *
 * `credit_balance` is a Drizzle `numeric` column, so it arrives at the row
 * boundary as a string (or null/garbage on a corrupt read). Two read paths
 * used to coerce it with a bare `Number(...)`:
 *
 *   - `CreditsService.getOrganizationBalanceUsd` — feeds the optimistic-billing
 *     gate and is written back as a KV balance hint.
 *   - `getCreditBalanceResponse` — the DTO returned to the dashboard / API.
 *
 * `Number(null)` becomes a fake $0 and `Number("not-a-number")` becomes `NaN`
 * that serializes to `balance: null` over JSON. These tests assert both paths
 * now fail loudly on corrupt reads instead of returning a wrong-but-plausible
 * number, and that the happy path + documented missing-org fail-safe still
 * behave.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { organizationsRepository } from "../../../db/repositories";
import type { Organization } from "../../../db/schemas/organizations";
import { ApiError } from "../../api/cloud-worker-errors";
import { getCreditBalanceResponse } from "../credit-balance-response";
import { creditsService } from "../credits";
import { organizationsService } from "../organizations";

const ORG_ID = "00000000-0000-0000-0000-0000000000f1";

function orgWithBalance(credit_balance: unknown): Organization {
  // Only `credit_balance` is exercised by the code under test; the rest of the
  // row is irrelevant, so cast a minimal object to the row type.
  return { id: ORG_ID, credit_balance } as unknown as Organization;
}

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()?.mockRestore();
});

describe("CreditsService.getOrganizationBalanceUsd fail-closed", () => {
  test("parses a well-formed numeric-string balance", async () => {
    const s = spyOn(organizationsRepository, "findBalanceSnapshotForWrite").mockResolvedValue({
      credit_balance: "12.5",
      balance_revision: "7",
    });
    spies.push(s);
    expect(await creditsService.getOrganizationBalanceUsd(ORG_ID)).toBe(12.5);
  });

  test("missing org returns 0 (documented gate fail-safe -> slow path)", async () => {
    const s = spyOn(organizationsRepository, "findBalanceSnapshotForWrite").mockResolvedValue(
      undefined,
    );
    spies.push(s);
    expect(await creditsService.getOrganizationBalanceUsd(ORG_ID)).toBe(0);
  });

  test("present org with null balance THROWS instead of coercing to NaN", async () => {
    const s = spyOn(organizationsRepository, "findBalanceSnapshotForWrite").mockResolvedValue({
      credit_balance: null,
      balance_revision: "7",
    });
    spies.push(s);
    await expect(creditsService.getOrganizationBalanceUsd(ORG_ID)).rejects.toThrow(
      /credit_balance/,
    );
  });

  test("present org with non-numeric balance THROWS (no NaN gate hint)", async () => {
    const s = spyOn(organizationsRepository, "findBalanceSnapshotForWrite").mockResolvedValue({
      credit_balance: "not-a-number",
      balance_revision: "7",
    });
    spies.push(s);
    await expect(creditsService.getOrganizationBalanceUsd(ORG_ID)).rejects.toThrow(
      /credit_balance/,
    );
  });
});

describe("getCreditBalanceResponse fail-closed", () => {
  test("returns the parsed balance for a well-formed row", async () => {
    const s = spyOn(organizationsService, "getById").mockResolvedValue(orgWithBalance("42.000000"));
    spies.push(s);
    expect(await getCreditBalanceResponse(ORG_ID)).toEqual({ balance: 42 });
  });

  test("missing org throws a 404 (unchanged behavior)", async () => {
    const s = spyOn(organizationsService, "getById").mockResolvedValue(undefined);
    spies.push(s);
    await expect(getCreditBalanceResponse(ORG_ID)).rejects.toMatchObject({
      status: 404,
    });
  });

  test("null balance throws a 500 internal_error, not a fake $0 (Number(null)===0)", async () => {
    const s = spyOn(organizationsService, "getById").mockResolvedValue(orgWithBalance(null));
    spies.push(s);
    let thrown: unknown;
    try {
      await getCreditBalanceResponse(ORG_ID);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(500);
    expect((thrown as ApiError).code).toBe("internal_error");
  });

  test("non-numeric balance throws a 500 internal_error, not balance:null", async () => {
    const s = spyOn(organizationsService, "getById").mockResolvedValue(
      orgWithBalance("not-a-number"),
    );
    spies.push(s);
    let thrown: unknown;
    try {
      await getCreditBalanceResponse(ORG_ID);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(500);
    expect((thrown as ApiError).code).toBe("internal_error");
  });
});
