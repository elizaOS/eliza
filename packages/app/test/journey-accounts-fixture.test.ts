/**
 * Keeps the walkthrough's account inventory fixture aligned with the UI API boundary.
 */

import { ElizaError } from "@elizaos/core";
import {
  ACCOUNTS_RESPONSE_INVALID_CODE,
  parseAccountsListResponse,
} from "@elizaos/ui/api/client-agent-accounts-validator";
import { describe, expect, it } from "vitest";
import { WALKTHROUGH_ACCOUNTS_RESPONSE } from "./ui-smoke/walkthrough/journey";

describe("walkthrough accounts fixture", () => {
  it("satisfies the canonical accounts response schema", () => {
    expect(parseAccountsListResponse(WALKTHROUGH_ACCOUNTS_RESPONSE)).toBe(
      WALKTHROUGH_ACCOUNTS_RESPONSE,
    );
  });

  it("rejects the legacy accounts-array fixture shape with structured context", async () => {
    const outcome = await Promise.resolve()
      .then(() => parseAccountsListResponse({ accounts: [] }))
      .then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );

    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.error).toBeInstanceOf(ElizaError);
    expect(outcome.error).toMatchObject({
      code: ACCOUNTS_RESPONSE_INVALID_CODE,
      context: {
        path: "response.providers",
        expected: "an array",
      },
    });
  });
});
