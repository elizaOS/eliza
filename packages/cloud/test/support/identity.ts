// spec/cloud/identity/accounts.md, "Story: Get one account on first sign-in"; spec/cloud/identity/sessions.md, "Story: Stay signed in"
import { Clock, Effect } from "effect";
import { landAccount } from "../../src/identity/accounts.vibe";
import { issueSession } from "../../src/identity/sessions.vibe";
import type { TestCloud } from "./cloud.vibe";

export const signedIn = (cloud: TestCloud, email: string) =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    cloud.store.transaction((tx) =>
      Effect.flatMap(landAccount(tx, { method: "EmailSignIn", subject: email }, email, now), (landed) =>
        issueSession(tx, { userId: landed.userId, organizationId: landed.organizationId, assurance: "SingleFactor", accountCreated: landed.created, now }),
      ),
    ),
  );
