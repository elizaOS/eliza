/**
 * Keeps the walkthrough's account inventory fixture aligned with the UI API boundary.
 */

import { parseAccountsListResponse } from "@elizaos/ui/api/client-agent-accounts-validator";
import { describe, expect, it } from "vitest";
import { WALKTHROUGH_ACCOUNTS_RESPONSE } from "./journey";

describe("walkthrough accounts fixture", () => {
  it("satisfies the canonical accounts response schema", () => {
    expect(parseAccountsListResponse(WALKTHROUGH_ACCOUNTS_RESPONSE)).toBe(
      WALKTHROUGH_ACCOUNTS_RESPONSE,
    );
  });

  it("rejects the legacy accounts-array fixture shape", () => {
    expect(() => parseAccountsListResponse({ accounts: [] })).toThrow(
      "response.providers",
    );
  });
});
