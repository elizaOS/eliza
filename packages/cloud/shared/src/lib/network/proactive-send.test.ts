/** Network proactive sends: gateway delivery first, then an assistant turn in the Network history. */

import { describe, expect, test } from "bun:test";
import type { SharedProjectProactiveTurn } from "../services/shared-runtime/conversation-coordinator";
import { personalSharedAgentId } from "../services/shared-runtime/personal-shared-identity";
import { networkProactiveTurnId, sendNetworkProactiveMessage } from "./proactive-send";

const member = {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  organizationId: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
};
const input = {
  ...member,
  platform: "twilio" as const,
  phoneNumber: "+14155550123",
  text: "Ada is free Thursday at 6. Want me to set up a coffee intro?",
  idempotencyKey: "network:intro:opp-1:mem-1:1",
};

function harness(response: () => Response) {
  const delivered: Record<string, unknown>[] = [];
  const appended: Array<{ agentId: string; turn: SharedProjectProactiveTurn }> = [];
  return {
    delivered,
    appended,
    deps: {
      deliver: async (body: Record<string, unknown>) => {
        delivered.push(body);
        return response();
      },
      appendHistory: async (agentId: string, turn: SharedProjectProactiveTurn) => {
        appended.push({ agentId, turn });
      },
      now: () => 1_790_000_000_000,
    },
  };
}

describe("sendNetworkProactiveMessage", () => {
  test("an accepted send is appended to the Network (not Eliza) history as an assistant turn", async () => {
    const { deps, delivered, appended } = harness(() =>
      Response.json({
        success: true,
        replayed: false,
        acceptedAt: "2026-10-06T18:00:00.000Z",
        providerMessageIds: ["SM1"],
      }),
    );
    const result = await sendNetworkProactiveMessage(input, deps);
    const networkAgentId = personalSharedAgentId({ ...member, project: "network" });
    expect(result).toEqual({
      ok: true,
      agentId: networkAgentId,
      replayed: false,
      providerMessageIds: ["SM1"],
      historyTurnId: networkProactiveTurnId(input.idempotencyKey),
    });
    expect(networkAgentId).not.toBe(personalSharedAgentId(member));
    expect(delivered).toEqual([
      {
        platform: "twilio",
        project: "network",
        phoneNumber: input.phoneNumber,
        text: input.text,
        idempotencyKey: input.idempotencyKey,
      },
    ]);
    expect(appended).toEqual([
      {
        agentId: networkAgentId,
        turn: {
          project: "network",
          ...member,
          id: "network-proactive:network:intro:opp-1:mem-1:1",
          content: input.text,
          createdAt: Date.parse("2026-10-06T18:00:00.000Z"),
        },
      },
    ]);
  });

  test("a replayed receipt re-appends the same turn id (idempotent merge)", async () => {
    const { deps, appended } = harness(() =>
      Response.json({ success: true, replayed: true, providerMessageIds: ["SM1"] }),
    );
    const first = await sendNetworkProactiveMessage(input, deps);
    const second = await sendNetworkProactiveMessage(input, deps);
    expect(first.ok && second.ok && first.replayed).toBe(true);
    expect(appended.map((entry) => entry.turn.id)).toEqual([
      networkProactiveTurnId(input.idempotencyKey),
      networkProactiveTurnId(input.idempotencyKey),
    ]);
    expect(appended[0]?.turn.createdAt).toBe(1_790_000_000_000);
  });

  test("refused, opted-out and unknown deliveries never touch history", async () => {
    for (const [response, acceptance] of [
      [
        () =>
          Response.json(
            { success: false, code: "recipient_opted_out", acceptance: "not_accepted" },
            { status: 422 },
          ),
        "not_accepted",
      ],
      [
        () =>
          Response.json(
            { success: false, acceptance: "unknown", acceptanceUnknown: true },
            { status: 202 },
          ),
        "unknown",
      ],
      [() => new Response("not json", { status: 502 }), "not_accepted"],
    ] as const) {
      const { deps, appended } = harness(response);
      const result = await sendNetworkProactiveMessage(input, deps);
      expect(result.ok).toBe(false);
      expect(result.ok ? null : result.acceptance).toBe(acceptance);
      expect(appended).toEqual([]);
    }
    const { deps, appended } = harness(() => Response.json({}));
    const throwing = {
      ...deps,
      deliver: async () => {
        throw new Error("socket hang up");
      },
    };
    expect(await sendNetworkProactiveMessage(input, throwing)).toMatchObject({
      ok: false,
      acceptance: "unknown",
    });
    expect(appended).toEqual([]);
  });
});
