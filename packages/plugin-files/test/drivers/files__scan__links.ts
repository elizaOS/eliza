// spec/files/scan/links.md, "Story: Review links in my scanned text and open the one I choose"
import { Deferred, Effect, Fiber } from "effect";
import type { Driver, Options } from "../../gen/files__scan__links.conformance.ts";
import type { LinkStatus, ScanLinkReview } from "../../gen/files__scan__links.ts";
import { scanLinkReview } from "@elizaos/plugin-files-client";

type View = { readonly status: LinkStatus; readonly busy: boolean };
const view = ({ status, flight }: ScanLinkReview): View => ({ status, busy: flight !== 0 });

const VALID_URL = "https://example.com/menu";
const OTHER_URL = "https://other.example/nope";

interface Session {
  readonly review: Effect.Success<ReturnType<typeof scanLinkReview>>;
  readonly gates: Map<number, { readonly reply: Deferred.Deferred<boolean>; readonly fiber: Fiber.Fiber<unknown> }>;
  active: boolean;
  generation: number;
  flight: number;
  pending: Deferred.Deferred<boolean> | undefined;
}

const sessions = new Map<string, Session>();

function sessionOf(key: string): Session {
  const existing = sessions.get(key);
  if (existing !== undefined) return existing;
  const created: Session = {
    review: undefined as unknown as Effect.Success<ReturnType<typeof scanLinkReview>>,
    gates: new Map(),
    active: true,
    generation: 1,
    flight: 0,
    pending: undefined,
  };
  const review = Effect.runSync(scanLinkReview(
    () => Effect.suspend(() => {
      const gate = created.pending;
      return gate === undefined ? Effect.succeed(true) : Deferred.await(gate);
    }),
    () => created.active,
  ));
  (created as { review: typeof review }).review = review;
  Effect.runSync(review.update(`Visit ${VALID_URL}`));
  sessions.set(key, created);
  return created;
}

export const driver: Driver<View> = {
  reset() {
    sessions.clear();
  },
  async dispatch(key, event) {
    const session = sessionOf(key);
    switch (event.type) {
      case "refreshLinks": {
        session.generation += 1;
        await Effect.runPromise(session.review.update(`Visit ${VALID_URL}`));
        return "accepted";
      }
      case "openNativeScanLink": {
        if (!(event.active && event.exactAddress && session.flight === 0)) {
          session.active = event.active;
          await Effect.runPromise(session.review.open(event.exactAddress ? VALID_URL : OTHER_URL));
          return "refused";
        }
        const reply = Effect.runSync(Deferred.make<boolean>());
        const token = session.generation;
        session.active = true;
        session.flight = token;
        session.pending = reply;
        const fiber = Effect.runFork(session.review.open(VALID_URL));
        session.gates.set(token, { reply, fiber });
        await Effect.runPromise(Effect.yieldNow);
        return "accepted";
      }
      case "finishNativeScanLink": {
        if (!(event.token > 0 && event.token === session.flight)) return "refused";
        const held = session.gates.get(event.token);
        if (held === undefined) return "refused";
        session.active = event.active;
        session.flight = 0;
        session.gates.delete(event.token);
        await Effect.runPromise(Deferred.succeed(held.reply, event.opened));
        await Effect.runPromise(Fiber.await(held.fiber));
        return "accepted";
      }
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  },
  observe: async (key): Promise<View> => {
    const current = await Effect.runPromise(sessionOf(key).review.view());
    return { status: current.status, busy: current.busy };
  },
};

export const options: Options<View> = { view, keys: ["scan"] };
