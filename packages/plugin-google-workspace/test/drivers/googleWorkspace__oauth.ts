// spec/googleWorkspace/oauth.md, "Story: Connect, refresh, and disconnect a Google Workspace account without leaving stale grants active"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/googleWorkspace__oauth.conformance.ts";
import type { WorkspaceConnection } from "../../gen/googleWorkspace__oauth.ts";
import { createOAuthSession } from "../../src/index.vibe";

type Session = Effect.Success<ReturnType<typeof createOAuthSession>>;

const sessions = new Map<string, Session>();

function sessionOf(key: string): Session {
  const existing = sessions.get(key);
  if (existing !== undefined) return existing;
  const created = Effect.runSync(createOAuthSession());
  sessions.set(key, created);
  return created;
}

async function runTransition(work: Effect.Effect<WorkspaceConnection, unknown>): Promise<"accepted" | "refused"> {
  const result = await Effect.runPromise(Effect.result(work));
  return result._tag === "Success" ? "accepted" : "refused";
}

export const driver: Driver<WorkspaceConnection> = {
  reset() {
    sessions.clear();
  },
  async dispatch(key, event) {
    const session = sessionOf(key);
    switch (event.type) {
      case "startOAuth":
        return runTransition(session.startOAuth(event.stateNonce));
      case "completeOAuth":
        return runTransition(session.completeOAuth(event.stateNonce, event.hasRefresh, event.scopes));
      case "cancelOAuth":
        return runTransition(session.cancelOAuth());
      case "expireAccess":
        return runTransition(session.expireAccess());
      case "refreshAccess":
        return runTransition(session.refreshAccess(event.succeeded));
      case "disconnect":
        return runTransition(session.disconnect());
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  },
  observe: (key) => Effect.runPromise(sessionOf(key).state()),
};

export const options: Options<WorkspaceConnection> = { keys: ["work", "personal"] };
