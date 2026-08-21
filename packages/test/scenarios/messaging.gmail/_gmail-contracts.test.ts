/** Tests the Gmail corpus helpers against synthetic turn-scoped provider ledgers. */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import {
  gmailDraftSendCorrelation,
  gmailNoWriteOnTurns,
  gmailRequestsForTurn,
  gmailWriteRequests,
} from "./_gmail-contracts.ts";

function context(method: string): ScenarioContext {
  return {
    actionsCalled: [],
    turns: [
      {
        name: "review",
        actionsCalled: [],
        providerRequests: [
          {
            provider: "gmail",
            method,
            path: "/gmail/v1/users/me/messages/batchModify",
          },
        ],
      },
    ],
  };
}

describe("Gmail corpus request helpers", () => {
  it("selects only the named turn and recognizes writes", () => {
    const requests = gmailRequestsForTurn(context("POST"), "review");
    expect(requests).toHaveLength(1);
    expect(gmailWriteRequests(requests)).toHaveLength(1);
    expect(gmailRequestsForTurn(context("POST"), "missing")).toEqual([]);
  });

  it("fails a no-write contract on a turn-scoped POST", async () => {
    const check = gmailNoWriteOnTurns("read only", "review");
    if (check.type !== "custom") throw new Error("expected custom check");
    await expect(
      Promise.resolve(check.predicate(context("POST"))),
    ).resolves.toContain("forbidden Gmail write");
    await expect(
      Promise.resolve(check.predicate(context("GET"))),
    ).resolves.toBeUndefined();
    await expect(
      Promise.resolve(
        check.predicate({
          actionsCalled: [],
          turns: [{ name: "review", actionsCalled: [] }],
        }),
      ),
    ).resolves.toContain("no turn-scoped Gmail provider ledger");
  });

  it("requires the confirmed send to consume the created draft ID", async () => {
    const check = gmailDraftSendCorrelation({
      name: "same draft",
      draftTurn: "draft",
      sendTurn: "send",
    });
    if (check.type !== "custom") throw new Error("expected custom check");
    const correlated: ScenarioContext = {
      actionsCalled: [],
      turns: [
        {
          name: "draft",
          actionsCalled: [
            {
              actionName: "MESSAGE",
              result: { data: { draftId: "draft-42", source: "gmail" } },
            },
          ],
        },
        {
          name: "send",
          actionsCalled: [
            {
              actionName: "MESSAGE",
              parameters: {
                parameters: { draftId: "draft-42", confirmed: true },
              },
            },
          ],
        },
      ],
    };
    await expect(
      Promise.resolve(check.predicate(correlated)),
    ).resolves.toBeUndefined();
    correlated.turns?.[1]?.actionsCalled.splice(0, 1, {
      actionName: "MESSAGE",
      parameters: { parameters: { draftId: "draft-other", confirmed: true } },
    });
    await expect(
      Promise.resolve(check.predicate(correlated)),
    ).resolves.toContain("did not consume exactly");
  });
});
