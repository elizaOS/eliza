// spec/wallet/policy.md, "Story: Enforce spend policy, slippage limits, and a tamper-evident audit chain"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/wallet__policy.conformance.ts";
import type { PolicyState } from "../../gen/wallet__policy.ts";
import { createPolicySession } from "../../src/index.vibe";

type Session = Effect.Success<ReturnType<typeof createPolicySession>>;

const sessions = new Map<string, Session>();

function sessionOf(key: string): Session {
  const existing = sessions.get(key);
  if (existing !== undefined) return existing;
  const created = Effect.runSync(createPolicySession());
  sessions.set(key, created);
  return created;
}

async function runTransition(work: Effect.Effect<PolicyState, unknown>): Promise<"accepted" | "refused"> {
  const result = await Effect.runPromise(Effect.result(work));
  return result._tag === "Success" ? "accepted" : "refused";
}

export const driver: Driver<PolicyState> = {
  reset() {
    sessions.clear();
  },
  async dispatch(key, event) {
    const session = sessionOf(key);
    switch (event.type) {
      case "recordSpend":
        return runTransition(session.recordSpend(event.amount, event.slippageBps));
      case "resetDailyWindow":
        return runTransition(session.resetDailyWindow());
      case "pausePolicy":
        return runTransition(session.pausePolicy());
      case "resumePolicy":
        return runTransition(session.resumePolicy());
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  },
  observe: (key) => Effect.runPromise(sessionOf(key).state()),
};

export const options: Options<PolicyState> = { keys: ["default", "trading"] };
