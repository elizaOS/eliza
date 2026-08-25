/**
 * OWNER_FINANCES dispatch routing.
 *
 * A single `subaction` discriminator decides which backend handles a
 * request — subscriptions (subscription_* verbs) or payments (everything
 * else). Contracts pinned here:
 *  - Routing is case/whitespace-normalized: "Subscription_List " must reach
 *    the subscriptions backend as subaction "list".
 *  - The subscription_ prefix is STRIPPED before forwarding so the backend
 *    receives its native subaction vocabulary.
 *  - Anything that does not start with the exact subscription_ prefix —
 *    including the lookalike "subscriptions_*" — routes to payments, which
 *    must receive the ORIGINAL options (its dashboard default behavior).
 *  - A missing subaction or missing options still routes to payments and
 *    never throws.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runMoneyHandler } from "./money";

const handlers = vi.hoisted(() => ({
  payments: vi.fn(),
  subscriptions: vi.fn(),
}));

vi.mock("./payments.js", () => ({ runPaymentsHandler: handlers.payments }));
vi.mock("./subscriptions.js", () => ({
  runSubscriptionsHandler: handlers.subscriptions,
}));

const RUNTIME = { agentId: "agent-1" };
const MESSAGE = { id: "msg-1" };
const STATE = { values: { x: 1 } };

describe("runMoneyHandler routing", () => {
  beforeEach(() => {
    handlers.payments.mockReset();
    handlers.subscriptions.mockReset();
    handlers.payments.mockResolvedValue({ ok: true, backend: "payments" });
    handlers.subscriptions.mockResolvedValue({
      ok: true,
      backend: "subscriptions",
    });
  });

  it("routes subscription_cancel to the subscriptions backend with the prefix stripped", async () => {
    const result = await runMoneyHandler(
      RUNTIME as never,
      MESSAGE as never,
      STATE as never,
      {
        parameters: { subaction: "subscription_cancel", quiet: true },
      } as never,
    );
    expect(handlers.subscriptions).toHaveBeenCalledTimes(1);
    expect(handlers.subscriptions.mock.calls[0]).toEqual([
      RUNTIME,
      MESSAGE,
      STATE,
      { parameters: { quiet: true, subaction: "cancel" } },
    ]);
    expect(result).toEqual({ ok: true, backend: "subscriptions" });
    expect(handlers.payments).not.toHaveBeenCalled();
  });

  it("normalizes case and whitespace before routing", async () => {
    await runMoneyHandler(
      RUNTIME as never,
      MESSAGE as never,
      STATE as never,
      {
        parameters: { subaction: "  Subscription_List  " },
      } as never,
    );
    expect(handlers.subscriptions).toHaveBeenCalledTimes(1);
    expect(handlers.subscriptions.mock.calls[0][3]).toEqual({
      parameters: { subaction: "list" },
    });
    expect(handlers.payments).not.toHaveBeenCalled();
  });

  it("forwards an empty remainder when the prefix is the whole subaction", async () => {
    await runMoneyHandler(
      RUNTIME as never,
      MESSAGE as never,
      STATE as never,
      {
        parameters: { subaction: "subscription_" },
      } as never,
    );
    expect(handlers.subscriptions).toHaveBeenCalledTimes(1);
    expect(handlers.subscriptions.mock.calls[0][3]).toEqual({
      parameters: { subaction: "" },
    });
    expect(handlers.payments).not.toHaveBeenCalled();
  });

  it("routes dashboard to the payments backend with options preserved", async () => {
    const options = { parameters: { subaction: "dashboard" } };
    await runMoneyHandler(
      RUNTIME as never,
      MESSAGE as never,
      STATE as never,
      options as never,
    );
    expect(handlers.payments).toHaveBeenCalledTimes(1);
    expect(handlers.payments).toHaveBeenCalledWith(
      RUNTIME,
      MESSAGE,
      STATE,
      options,
    );
    expect(handlers.subscriptions).not.toHaveBeenCalled();
  });

  it("routes the lookalike subscriptions_cancel to payments (exact-prefix gate)", async () => {
    await runMoneyHandler(
      RUNTIME as never,
      MESSAGE as never,
      STATE as never,
      {
        parameters: { subaction: "subscriptions_cancel" },
      } as never,
    );
    expect(handlers.payments).toHaveBeenCalledTimes(1);
    expect(handlers.subscriptions).not.toHaveBeenCalled();
  });

  it("routes a missing subaction to payments with the default dashboard behavior", async () => {
    await runMoneyHandler(
      RUNTIME as never,
      MESSAGE as never,
      STATE as never,
      {
        parameters: {},
      } as never,
    );
    expect(handlers.payments).toHaveBeenCalledTimes(1);
    expect(handlers.payments.mock.calls[0][3]).toEqual({ parameters: {} });
    expect(handlers.subscriptions).not.toHaveBeenCalled();
  });

  it("tolerates missing options entirely", async () => {
    await runMoneyHandler(
      RUNTIME as never,
      MESSAGE as never,
      STATE as never,
      undefined,
    );
    expect(handlers.payments).toHaveBeenCalledTimes(1);
    expect(handlers.payments.mock.calls[0][3]).toBeUndefined();
    expect(handlers.subscriptions).not.toHaveBeenCalled();
  });

  it("tolerates non-object parameters", async () => {
    await runMoneyHandler(
      RUNTIME as never,
      MESSAGE as never,
      STATE as never,
      {
        parameters: "weird",
      } as never,
    );
    expect(handlers.payments).toHaveBeenCalledTimes(1);
    expect(handlers.subscriptions).not.toHaveBeenCalled();
  });
});
