/**
 * Idempotency-key contract for the card checkout (#24144).
 *
 * The server requires an Idempotency-Key header (8-128 chars,
 * ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$) on non-hardware credit purchases and
 * scopes durable checkout orders to (org, key). These tests pin the client
 * side: key present and well-formed on card checkout, reused across retries
 * of the same amount after transient/ambiguous failures, rotated when the
 * amount changes (including the A -> B -> A resurrection trap), absent from
 * the crypto path, and never generated for invalid submissions.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      _code: string,
      message: string,
    ) {
      super(message);
      this.name = "ApiError";
    }
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../../shell/CloudI18nProvider", () => ({
  useCloudT:
    () =>
    (
      _key: string,
      opts?: { defaultValue?: string } & Record<string, unknown>,
    ) => {
      let value = opts?.defaultValue ?? _key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          if (k === "defaultValue") continue;
          value = value.replace(`{{${k}}}`, String(v));
        }
      }
      return value;
    },
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("../data/billing-snapshot", () => ({
  useBillingSnapshotV2: () => ({
    data: {
      snapshotStartedAt: "2026-08-21T10:20:30.000Z",
      snapshotCompletedAt: "2026-08-21T10:20:30.000Z",
      balance: {
        status: "available",
        source: "credit-ledger",
        observedAt: "2026-08-21T10:20:30.000Z",
        value: {
          balance: { value: "12.500000", unit: "usd", currency: "USD" },
          revision: "7",
        },
      },
      activeCompute: {
        resources: {
          status: "available",
          source: "compute",
          observedAt: "2026-08-21T10:20:30.000Z",
          value: [],
        },
        estimatedRecurringComputeCostPerDay: {
          status: "available",
          source: "compute",
          observedAt: "2026-08-21T10:20:30.000Z",
          value: { value: "0.000000", unit: "usd_per_day", currency: "USD" },
        },
      },
    },
    isError: false,
    isFetching: false,
    isRefetchError: false,
    fetchStatus: "idle",
    refetch: vi.fn(),
  }),
}));

vi.mock("./auto-top-up-card", () => ({
  AutoTopUpCard: () => null,
}));

import type { BillingUser, InvoiceDisplay } from "../types";
import { BillingTab, type CardCheckoutIntentStore } from "./billing-tab";

const user: BillingUser = {
  organization_id: "org-1",
  wallet_address: null,
};

const invoices: InvoiceDisplay[] = [
  { id: "inv-1", date: "2024-01-02 10:00", total: "$25.00", status: "paid" },
];

/** The server's exact header contract. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function routeApi(
  checkoutResponse: () => Promise<unknown> = () => Promise.resolve({}),
) {
  apiMock.mockImplementation((url: string) => {
    if (url.startsWith("/api/invoices/list")) {
      return Promise.resolve({ invoices });
    }
    if (url.startsWith("/api/credits/balance")) {
      return Promise.resolve({ balance: 12.5 });
    }
    if (url.startsWith("/api/crypto/status")) {
      return Promise.resolve({ enabled: false });
    }
    if (url.startsWith("/api/stripe/create-checkout-session")) {
      return checkoutResponse();
    }
    return Promise.resolve({});
  });
}

/** Extract the Idempotency-Key from the nth checkout call. */
function checkoutCalls() {
  return apiMock.mock.calls.filter(([url]) =>
    String(url).startsWith("/api/stripe/create-checkout-session"),
  );
}

function keyOf(call: unknown[]): string {
  const init = call[1] as { headers?: Record<string, string> };
  return init?.headers?.["Idempotency-Key"] ?? "";
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function submitFormAmount(amount: string) {
  const input = screen.getByLabelText("Amount (USD)");
  fireEvent.change(input, { target: { value: amount } });
  const form = input.closest("form");
  if (!form) throw new Error("Billing checkout form is missing");
  fireEvent.submit(form);
}

async function submitAmount(
  actor: UserEvent,
  amount: string,
  opts: { buttonName?: RegExp } = {},
) {
  const input = screen.getByLabelText("Amount (USD)");
  await actor.clear(input);
  await actor.type(input, amount);
  await actor.click(
    screen.getByRole("button", { name: opts.buttonName ?? /Buy credits/i }),
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("BillingTab card-checkout idempotency key (#24144)", () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it("sends a server-contract-valid Idempotency-Key on card checkout (click path)", async () => {
    routeApi();
    const actor = userEvent.setup();
    render(<BillingTab user={user} />);

    await screen.findAllByTestId("invoice-row");
    await submitAmount(actor, "25");

    await waitFor(() => {
      expect(checkoutCalls()).toHaveLength(1);
    });
    const key = keyOf(checkoutCalls()[0]);
    expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
    // A UUID (36 chars) satisfies the contract and is collision-safe.
    expect(key).toHaveLength(36);
    // The body contract is unchanged.
    const init = checkoutCalls()[0][1] as { json: unknown };
    expect(init.json).toEqual({ amount: 25, returnUrl: "settings" });
  });

  it("reuses the same key when the same amount is retried after a transient failure", async () => {
    let attempt = 0;
    routeApi(() => {
      attempt += 1;
      // 503 = transient server condition: the order may exist server-side.
      if (attempt === 1) {
        return Promise.reject(
          new (class extends Error {
            status = 503;
          })("upstream unavailable"),
        );
      }
      return Promise.resolve({});
    });
    const actor = userEvent.setup();
    render(<BillingTab user={user} />);

    await screen.findAllByTestId("invoice-row");
    await submitAmount(actor, "25");
    await waitFor(() => {
      expect(checkoutCalls()).toHaveLength(1);
    });
    // Wait for the processing state to reset before retrying.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Buy credits/i })).toBeTruthy();
    });
    await submitAmount(actor, "25");

    await waitFor(() => {
      expect(checkoutCalls()).toHaveLength(2);
    });
    expect(keyOf(checkoutCalls()[0])).toBe(keyOf(checkoutCalls()[1]));
  });

  it("rotates the key when the amount changes before retry", async () => {
    let attempt = 0;
    routeApi(() => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve({});
    });
    const actor = userEvent.setup();
    render(<BillingTab user={user} />);

    await screen.findAllByTestId("invoice-row");
    await submitAmount(actor, "25");
    await waitFor(() => {
      expect(checkoutCalls()).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Buy credits/i })).toBeTruthy();
    });
    await submitAmount(actor, "30");

    await waitFor(() => {
      expect(checkoutCalls()).toHaveLength(2);
    });
    expect(keyOf(checkoutCalls()[0])).not.toBe(keyOf(checkoutCalls()[1]));
  });

  it("does not leak a key across different submitted amounts (A -> B -> A matrix)", async () => {
    // The intent slot is compared at SUBMIT time against the amount being
    // submitted. Editing without submitting never touches it, so:
    //   submit 25 (key K1) -> edit to 30 -> edit back to 25 -> submit 25
    // reuses K1 (same purchase intent, same request digest — safe replay),
    // while submitting 30 rotates. What must NEVER happen is key reuse
    // across DIFFERENT submitted amounts.
    routeApi();
    const actor = userEvent.setup();
    render(<BillingTab user={user} />);

    await screen.findAllByTestId("invoice-row");
    await submitAmount(actor, "25");
    await waitFor(() => {
      expect(checkoutCalls()).toHaveLength(1);
    });
    const k1 = keyOf(checkoutCalls()[0]);

    await submitAmount(actor, "30");
    await waitFor(() => {
      expect(checkoutCalls()).toHaveLength(2);
    });
    const k2 = keyOf(checkoutCalls()[1]);
    expect(k2).not.toBe(k1);

    await submitAmount(actor, "25");
    await waitFor(() => {
      expect(checkoutCalls()).toHaveLength(3);
    });
    const k3 = keyOf(checkoutCalls()[2]);
    // No key is ever shared across different submitted amounts: the final
    // 25-submission must differ from BOTH the 30 key and the original 25
    // key. The k3 !== k1 assertion is the one that kills a per-amount key
    // MAP regression (a map would resurrect k1 for the return to 25).
    expect(k3).not.toBe(k2);
    expect(k3).not.toBe(k1);
  });

  it("reuses the key when the amount is edited away and back WITHOUT an intervening submit", async () => {
    // The single-slot intent survives non-submitting edits: the intent was
    // never used for another amount, so resubmitting the same amount is the
    // same purchase intent (same request digest) and replays safely.
    let attempt = 0;
    routeApi(() => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(new Error("network down"));
      }
      return Promise.resolve({});
    });
    const actor = userEvent.setup();
    render(<BillingTab user={user} />);

    await screen.findAllByTestId("invoice-row");
    await submitAmount(actor, "25");
    await waitFor(() => {
      expect(checkoutCalls()).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Buy credits/i })).toBeTruthy();
    });
    // Edit away and back without submitting.
    const input = screen.getByLabelText("Amount (USD)");
    await actor.clear(input);
    await actor.type(input, "30");
    await actor.clear(input);
    await actor.type(input, "25");
    await actor.click(screen.getByRole("button", { name: /Buy credits/i }));

    await waitFor(() => {
      expect(checkoutCalls()).toHaveLength(2);
    });
    expect(keyOf(checkoutCalls()[1])).toBe(keyOf(checkoutCalls()[0]));
  });

  it("makes no checkout request for an invalid amount", async () => {
    routeApi();
    const actor = userEvent.setup();
    render(<BillingTab user={user} />);

    await screen.findAllByTestId("invoice-row");
    await submitAmount(actor, "0");

    await waitFor(() => {
      expect(screen.getByText(/Minimum amount is \$1/i)).toBeTruthy();
    });
    expect(checkoutCalls()).toHaveLength(0);
  });

  it("generates a fresh key on retry after a definitive 400 — the server rejected before ordering", async () => {
    // A definitive 4xx clears the intent: the server rejected the request
    // before creating any durable order, so a retry MUST use a new key.
    // The rejection must be a real (mocked-module) ApiError instance — the
    // component classifies via instanceof.
    const apiClient = await import("../../lib/api-client");
    let attempt = 0;
    routeApi(() => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(
          new apiClient.ApiError(
            400,
            "invalid",
            "Idempotency-Key header is invalid",
          ),
        );
      }
      return Promise.resolve({});
    });
    const actor = userEvent.setup();
    render(<BillingTab user={user} />);

    await screen.findAllByTestId("invoice-row");
    await submitAmount(actor, "25");
    await waitFor(() => {
      expect(checkoutCalls()).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Buy credits/i })).toBeTruthy();
    });
    await submitAmount(actor, "25");

    await waitFor(() => {
      expect(checkoutCalls()).toHaveLength(2);
    });
    expect(keyOf(checkoutCalls()[0])).not.toBe(keyOf(checkoutCalls()[1]));
  });

  it("does not let an older 4xx clear a newer ambiguous checkout intent", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let attempt = 0;
    routeApi(() => {
      attempt += 1;
      if (attempt === 1) return first.promise;
      if (attempt === 2) return second.promise;
      return Promise.resolve({});
    });
    const apiClient = await import("../../lib/api-client");
    render(<BillingTab user={user} />);
    await screen.findAllByTestId("invoice-row");

    submitFormAmount("25");
    await waitFor(() => expect(checkoutCalls()).toHaveLength(1));
    submitFormAmount("30");
    await waitFor(() => expect(checkoutCalls()).toHaveLength(2));

    first.reject(new apiClient.ApiError(400, "invalid", "rejected"));
    second.reject(new Error("response lost"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Buy credits/i })).toBeTruthy(),
    );
    submitFormAmount("30");
    await waitFor(() => expect(checkoutCalls()).toHaveLength(3));

    expect(keyOf(checkoutCalls()[0])).not.toBe(keyOf(checkoutCalls()[1]));
    expect(keyOf(checkoutCalls()[2])).toBe(keyOf(checkoutCalls()[1]));
  });

  it("does not let an older ambiguous completion restore a rejected newer intent", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let attempt = 0;
    routeApi(() => {
      attempt += 1;
      if (attempt === 1) return first.promise;
      if (attempt === 2) return second.promise;
      return Promise.resolve({});
    });
    const apiClient = await import("../../lib/api-client");
    render(<BillingTab user={user} />);
    await screen.findAllByTestId("invoice-row");

    submitFormAmount("25");
    await waitFor(() => expect(checkoutCalls()).toHaveLength(1));
    submitFormAmount("30");
    await waitFor(() => expect(checkoutCalls()).toHaveLength(2));
    const rejectedKey = keyOf(checkoutCalls()[1]);

    second.reject(new apiClient.ApiError(400, "invalid", "rejected"));
    first.reject(new Error("older response lost"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Buy credits/i })).toBeTruthy(),
    );
    submitFormAmount("30");
    await waitFor(() => expect(checkoutCalls()).toHaveLength(3));

    expect(keyOf(checkoutCalls()[2])).not.toBe(rejectedKey);
    expect(keyOf(checkoutCalls()[2])).not.toBe(keyOf(checkoutCalls()[0]));
  });

  it("reuses an ambiguous intent after BillingTab unmounts and remounts", async () => {
    const intentStore: CardCheckoutIntentStore = { current: null };
    let attempt = 0;
    routeApi(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("response lost"))
        : Promise.resolve({});
    });
    const firstRender = render(
      <BillingTab user={user} checkoutIntentStore={intentStore} />,
    );
    await screen.findAllByTestId("invoice-row");
    const actor = userEvent.setup();
    await submitAmount(actor, "25");
    await waitFor(() => expect(checkoutCalls()).toHaveLength(1));
    const originalKey = keyOf(checkoutCalls()[0]);

    firstRender.unmount();
    render(<BillingTab user={user} checkoutIntentStore={intentStore} />);
    await screen.findAllByTestId("invoice-row");
    await submitAmount(actor, "25");
    await waitFor(() => expect(checkoutCalls()).toHaveLength(2));

    expect(keyOf(checkoutCalls()[1])).toBe(originalKey);
  });

  it("sends no Idempotency-Key on the hosted crypto path", async () => {
    apiMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/invoices/list")) {
        return Promise.resolve({ invoices });
      }
      if (url.startsWith("/api/credits/balance")) {
        return Promise.resolve({ balance: 12.5 });
      }
      if (url.startsWith("/api/crypto/status")) {
        return Promise.resolve({
          enabled: true,
          directWallet: { enabled: false },
        });
      }
      if (url.startsWith("/api/crypto/payments")) {
        // A javascript: payLink is refused client-side (no jsdom navigation),
        // proving the request itself was made — which is the assertion here.
        return Promise.resolve({ payLink: "javascript:void(0)" });
      }
      return Promise.resolve({});
    });
    const actor = userEvent.setup();
    render(<BillingTab user={user} />);

    await screen.findAllByTestId("invoice-row");
    // Select the crypto payment-method toggle then submit via its own button.
    await actor.click(screen.getByRole("button", { name: /^Crypto$/i }));
    await submitAmount(actor, "25", { buttonName: /Pay with Crypto/i });

    await waitFor(() => {
      expect(
        apiMock.mock.calls.some(([url]) =>
          String(url).startsWith("/api/crypto/payments"),
        ),
      ).toBe(true);
    });
    const cryptoCall = apiMock.mock.calls.find(([url]) =>
      String(url).startsWith("/api/crypto/payments"),
    );
    const init = cryptoCall?.[1] as
      | { headers?: Record<string, string> }
      | undefined;
    expect(init?.headers?.["Idempotency-Key"]).toBeUndefined();
    expect(checkoutCalls()).toHaveLength(0);
  });
});
