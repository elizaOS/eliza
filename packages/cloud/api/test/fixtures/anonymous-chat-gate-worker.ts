/** Runs the real gate in Workerd and lets tests advance persisted deadlines. */
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { AnonymousChatGate } from "../../src/anonymous-chat-gate";

type GateBindings = AppEnv["Bindings"] & { GATES: DurableObjectNamespace };
type LeaseClock = {
  expiresAtMs: number;
  hourlyResetAtMs: number;
};
type LedgerClock = {
  status: "ready" | "invalid";
  activeLeases: Record<string, LeaseClock>;
  hourlyResetAtMs: number | null;
  pendingSnapshot: { retryAtMs: number } | null;
};

export class AnonymousChatGateFixture {
  private gate: AnonymousChatGate;

  constructor(
    private readonly state: DurableObjectState,
    private readonly bindings: GateBindings,
  ) {
    this.gate = new AnonymousChatGate(state, bindings);
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/fixture/alarm") {
      try {
        await this.alarm();
        return Response.json({ ran: true });
      } catch {
        return Response.json({ ran: false }, { status: 503 });
      }
    }
    if (path === "/fixture/inspect") {
      return Response.json(await this.state.storage.get("ledger"));
    }
    if (path === "/fixture/advance") {
      const { requestId, remainingMs, rotateWindow, retryMirror } =
        (await request.json()) as {
          requestId?: string;
          remainingMs?: number;
          rotateWindow?: boolean;
          retryMirror?: boolean;
        };
      await this.state.storage.transaction(async (transaction) => {
        const ledger = await transaction.get<LedgerClock>("ledger");
        if (ledger?.status !== "ready") throw Error("No test ledger");
        const now = Date.now();
        if (requestId !== undefined && remainingMs !== undefined) {
          ledger.activeLeases[requestId].expiresAtMs = now + remainingMs;
        }
        if (rotateWindow) {
          const previous = ledger.hourlyResetAtMs;
          const old = now - 60 * 60 * 1_000 - 1;
          ledger.hourlyResetAtMs = old;
          for (const lease of Object.values(ledger.activeLeases)) {
            if (lease.hourlyResetAtMs === previous) lease.hourlyResetAtMs = old;
          }
        }
        if (retryMirror && ledger.pendingSnapshot) {
          ledger.pendingSnapshot.retryAtMs = now;
        }
        await transaction.put("ledger", ledger);
      });
      this.gate = new AnonymousChatGate(this.state, this.bindings);
      return Response.json({ advanced: true });
    }
    return this.gate.fetch(request);
  }

  async alarm(): Promise<void> {
    await this.gate.alarm();
  }
}

export default {
  fetch(request: Request, env: GateBindings): Promise<Response> {
    const [, name, ...path] = new URL(request.url).pathname.split("/");
    return env.GATES.getByName(name).fetch(
      new Request(`https://anonymous-chat-gate/${path.join("/")}`, request),
    );
  },
};
