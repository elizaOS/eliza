/**
 * Idempotency-key contract for the card checkout (#24144).
 *
 * The server requires an Idempotency-Key header (8-128 chars,
 * ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$) on non-hardware credit purchases and
 * scopes durable checkout orders to (org, initiating user, key). These tests
 * pin the client side: key present and well-formed on card checkout, reused across retries
 * of the same amount after transient/ambiguous failures, rotated when the
 * amount changes (including the A -> B -> A resurrection trap), absent from
 * the crypto path, and never generated for invalid submissions.
 */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

import {
  type CardCheckoutIntentCoordinator,
  type CardCheckoutIntentLockManager,
  type CardCheckoutIntentStorage,
  cardCheckoutIntentStorageKey,
  createCardCheckoutIntentCoordinator,
} from "../lib/card-checkout-intent";
import type { BillingUser, InvoiceDisplay } from "../types";
import { BillingTab } from "./billing-tab";

const user: BillingUser = {
  id: "user-1",
  organization_id: "org-1",
  wallet_address: null,
};

const invoices: InvoiceDisplay[] = [
  { id: "inv-1", date: "2024-01-02 10:00", total: "$25.00", status: "paid" },
];

/** The server's exact header contract. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

class MemoryStorage implements CardCheckoutIntentStorage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

class SerialLockManager implements CardCheckoutIntentLockManager {
  private tail: Promise<unknown> = Promise.resolve();

  request<T>(
    _name: string,
    options: { mode: "exclusive"; signal: AbortSignal },
    callback: () => T | PromiseLike<T>,
  ): Promise<T> {
    const result = this.tail.then(() => {
      if (options.signal.aborted)
        throw new DOMException("Aborted", "AbortError");
      return callback();
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

let checkoutCoordinator: CardCheckoutIntentCoordinator;
let nextUuid = 0;

function newUuid() {
  nextUuid += 1;
  return `00000000-0000-4000-8000-${String(nextUuid).padStart(12, "0")}`;
}

function createTestCoordinator(options?: {
  localStorage?: CardCheckoutIntentStorage | null;
  lockManager?: CardCheckoutIntentLockManager | null;
  sessionStorage?: CardCheckoutIntentStorage | null;
}) {
  return createCardCheckoutIntentCoordinator({
    localStorage:
      options && "localStorage" in options
        ? options.localStorage
        : new MemoryStorage(),
    sessionStorage:
      options && "sessionStorage" in options
        ? options.sessionStorage
        : new MemoryStorage(),
    lockManager:
      options && "lockManager" in options
        ? options.lockManager
        : new SerialLockManager(),
    now: () => 1_800_000_000_000,
    randomUUID: newUuid,
  });
}

function renderBillingTab(
  coordinator: CardCheckoutIntentCoordinator = checkoutCoordinator,
) {
  return render(
    <BillingTab user={user} checkoutIntentCoordinator={coordinator} />,
  );
}

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
  window.history.replaceState({}, "", window.location.pathname);
});

describe("BillingTab card-checkout idempotency key (#24144)", () => {
  beforeEach(() => {
    apiMock.mockReset();
    nextUuid = 0;
    checkoutCoordinator = createTestCoordinator();
  });

  it("sends a server-contract-valid Idempotency-Key on card checkout (click path)", async () => {
    routeApi();
    const actor = userEvent.setup();
    renderBillingTab();

    await screen.findAllByTestId("invoice-row");
    await submitAmount(actor, "25");

    await waitFor(() => {
      expect(checkoutCalls()).toHaveLength(1);
    });
    const key = keyOf(checkoutCalls()[0]);
    expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
    // A UUID (36 chars) satisfies the contract and is collision-safe.
    expect(key).toHaveLength(36);
    // The live server principal must still match the UI principal captured
    // before reservation; this closes an external account-switch race.
    const init = checkoutCalls()[0][1] as { json: unknown };
    expect(init.json).toEqual({
      amount: 25,
      expectedOrganizationId: "org-1",
      expectedUserId: "user-1",
      returnUrl: "settings",
    });
  });

  it("coordinates the same key across two mounted Billing tabs", async () => {
    const sharedStorage = new MemoryStorage();
    const sharedLockManager = new SerialLockManager();
    const firstCoordinator = createTestCoordinator({
      localStorage: sharedStorage,
      lockManager: sharedLockManager,
      sessionStorage: new MemoryStorage(),
    });
    const secondCoordinator = createTestCoordinator({
      localStorage: sharedStorage,
      lockManager: sharedLockManager,
      sessionStorage: new MemoryStorage(),
    });
    routeApi(() => new Promise(() => undefined));

    render(
      <>
        <section aria-label="Checkout tab A">
          <BillingTab
            user={user}
            checkoutIntentCoordinator={firstCoordinator}
          />
        </section>
        <section aria-label="Checkout tab B">
          <BillingTab
            user={user}
            checkoutIntentCoordinator={secondCoordinator}
          />
        </section>
      </>,
    );

    await waitFor(() =>
      expect(screen.getAllByTestId("invoice-row")).toHaveLength(2),
    );
    for (const name of ["Checkout tab A", "Checkout tab B"]) {
      const tab = within(screen.getByRole("region", { name }));
      // Two browser tabs have separate documents; this same-document harness
      // scopes each otherwise-identical form by region.
      const input = tab.getByRole("spinbutton");
      fireEvent.change(input, { target: { value: "25" } });
      const form = input.closest("form");
      if (!form) throw new Error(`Missing checkout form in ${name}`);
      fireEvent.submit(form);
    }

    await waitFor(() => expect(checkoutCalls()).toHaveLength(2));
    expect(keyOf(checkoutCalls()[0])).toBe(keyOf(checkoutCalls()[1]));
  });

  it("binds a valid returned session without clearing its intent before navigation", async () => {
    const checkoutUrl = new URL("#stripe-checkout", window.location.href).href;
    routeApi(() =>
      Promise.resolve({ sessionId: "cs_test_bound", url: checkoutUrl }),
    );
    renderBillingTab();
    await screen.findAllByTestId("invoice-row");

    submitFormAmount("25");
    await waitFor(() => expect(window.location.hash).toBe("#stripe-checkout"));

    const persisted = await checkoutCoordinator.reserve({
      organizationId: user.organization_id,
      initiatedByUserId: user.id,
      amountCents: 2_500,
    });
    expect(persisted.idempotencyKey).toBe(keyOf(checkoutCalls()[0]));
    expect(persisted.sessionId).toBe("cs_test_bound");
    window.history.replaceState({}, "", window.location.pathname);
  });

  it("navigates after binding when sessionStorage is unavailable and later scans for cleanup", async () => {
    const localStorage = new MemoryStorage();
    const coordinator = createTestCoordinator({
      localStorage,
      sessionStorage: null,
    });
    const checkoutUrl = new URL(
      "#stripe-checkout-no-session-storage",
      window.location.href,
    ).href;
    routeApi(() =>
      Promise.resolve({
        sessionId: "cs_test_no_session_storage",
        url: checkoutUrl,
      }),
    );
    renderBillingTab(coordinator);
    await screen.findAllByTestId("invoice-row");

    submitFormAmount("25");
    await waitFor(() =>
      expect(window.location.hash).toBe("#stripe-checkout-no-session-storage"),
    );
    expect(
      JSON.parse(
        localStorage.getItem(
          cardCheckoutIntentStorageKey(user.organization_id),
        ) ?? "null",
      ),
    ).toMatchObject({
      initiatedByUserId: user.id,
      sessionId: "cs_test_no_session_storage",
    });
    await expect(
      coordinator.clearVerifiedSession({
        sessionId: "cs_test_no_session_storage",
      }),
    ).resolves.toEqual({ status: "cleared", source: "namespace-scan" });
    window.history.replaceState({}, "", window.location.pathname);
  });

  it("invalidates an old response synchronously when the rendered principal changes", async () => {
    const localStorage = new MemoryStorage();
    const coordinator = createTestCoordinator({ localStorage });
    const oldResponse = deferred<unknown>();
    let checkoutAttempt = 0;
    routeApi(() => {
      checkoutAttempt += 1;
      return checkoutAttempt === 1
        ? oldResponse.promise
        : new Promise(() => undefined);
    });
    const bindSpy = vi.spyOn(coordinator, "bindSession");
    const firstRender = renderBillingTab(coordinator);
    await screen.findAllByTestId("invoice-row");
    submitFormAmount("25");
    await waitFor(() => expect(checkoutCalls()).toHaveLength(1));
    const oldKey = keyOf(checkoutCalls()[0]);

    const nextUser: BillingUser = { ...user, id: "user-2" };
    firstRender.rerender(
      <BillingTab user={nextUser} checkoutIntentCoordinator={coordinator} />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Buy credits/i })).toBeTruthy(),
    );

    await act(async () => {
      oldResponse.resolve({
        sessionId: "cs_test_old_account",
        url: new URL("#old-account-checkout", window.location.href).href,
      });
      await oldResponse.promise;
      await Promise.resolve();
    });

    expect(bindSpy).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
    expect(
      JSON.parse(
        localStorage.getItem(
          cardCheckoutIntentStorageKey(user.organization_id),
        ) ?? "null",
      ),
    ).toMatchObject({
      initiatedByUserId: user.id,
      idempotencyKey: oldKey,
      sessionId: null,
    });

    submitFormAmount("25");
    await waitFor(() => expect(checkoutCalls()).toHaveLength(2));
    expect(keyOf(checkoutCalls()[1])).not.toBe(oldKey);
    expect(
      (checkoutCalls()[1][1] as { json: Record<string, unknown> }).json,
    ).toMatchObject({
      expectedUserId: "user-2",
      expectedOrganizationId: "org-1",
    });
  });

  it("pins the reserved principal so an external auth switch is rejected before checkout side effects", async () => {
    const apiClient = await import("../../lib/api-client");
    const coordinator = createTestCoordinator();
    const originalReserve = coordinator.reserve.bind(coordinator);
    const bindSpy = vi.spyOn(coordinator, "bindSession");
    let livePrincipal = {
      userId: user.id,
      organizationId: user.organization_id,
    };
    const switchingCoordinator: CardCheckoutIntentCoordinator = {
      ...coordinator,
      reserve: async (input) => {
        const intent = await originalReserve(input);
        // Models another tab replacing the bearer/cookie after local reserve
        // but before apiFetch constructs the request.
        livePrincipal = { userId: "user-2", organizationId: "org-2" };
        return intent;
      },
    };
    const createOrderOrSession = vi.fn();
    apiMock.mockImplementation(
      (url: string, init?: { json?: Record<string, unknown> }) => {
        if (url.startsWith("/api/invoices/list")) {
          return Promise.resolve({ invoices });
        }
        if (url.startsWith("/api/crypto/status")) {
          return Promise.resolve({ enabled: false });
        }
        if (url.startsWith("/api/stripe/create-checkout-session")) {
          const expectedUserId = init?.json?.expectedUserId;
          const expectedOrganizationId = init?.json?.expectedOrganizationId;
          if (
            expectedUserId !== livePrincipal.userId ||
            expectedOrganizationId !== livePrincipal.organizationId
          ) {
            return Promise.reject(
              new apiClient.ApiError(
                409,
                "CHECKOUT_PRINCIPAL_CHANGED",
                "Checkout identity changed; refresh before retrying",
              ),
            );
          }
          createOrderOrSession();
          return Promise.resolve({
            sessionId: "cs_wrong_principal",
            url: new URL("#wrong-principal", window.location.href).href,
          });
        }
        return Promise.resolve({});
      },
    );

    renderBillingTab(switchingCoordinator);
    await screen.findAllByTestId("invoice-row");
    submitFormAmount("25");
    await waitFor(() => expect(checkoutCalls()).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Buy credits/i })).toBeTruthy(),
    );

    expect(
      (checkoutCalls()[0][1] as { json: Record<string, unknown> }).json,
    ).toMatchObject({
      expectedUserId: user.id,
      expectedOrganizationId: user.organization_id,
    });
    expect(createOrderOrSession).not.toHaveBeenCalled();
    expect(bindSpy).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  });

  it("fails closed with a persistent alert before POST when Web Locks are unavailable", async () => {
    routeApi();
    renderBillingTab(createTestCoordinator({ lockManager: null }));
    await screen.findAllByTestId("invoice-row");

    submitFormAmount("25");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "Card checkout could not be coordinated safely",
    );
    expect(alert.textContent).toContain("Android System WebView");
    expect(checkoutCalls()).toHaveLength(0);
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
    renderBillingTab();

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

  it("preserves the key after a malformed successful response", async () => {
    routeApi(() => Promise.resolve({ url: "https://checkout.example.test" }));
    renderBillingTab();
    await screen.findAllByTestId("invoice-row");

    submitFormAmount("25");
    await waitFor(() => expect(checkoutCalls()).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Buy credits/i })).toBeTruthy(),
    );
    submitFormAmount("25");
    await waitFor(() => expect(checkoutCalls()).toHaveLength(2));

    expect(keyOf(checkoutCalls()[1])).toBe(keyOf(checkoutCalls()[0]));
  });

  it.each([401, 403, 408, 409, 429])(
    "preserves the key after ambiguous HTTP %s",
    async (status) => {
      const apiClient = await import("../../lib/api-client");
      let attempt = 0;
      routeApi(() => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(
              new apiClient.ApiError(status, "ambiguous", "retry safely"),
            )
          : Promise.resolve({});
      });
      renderBillingTab();
      await screen.findAllByTestId("invoice-row");

      submitFormAmount("25");
      await waitFor(() => expect(checkoutCalls()).toHaveLength(1));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /Buy credits/i }),
        ).toBeTruthy(),
      );
      submitFormAmount("25");
      await waitFor(() => expect(checkoutCalls()).toHaveLength(2));

      expect(keyOf(checkoutCalls()[1])).toBe(keyOf(checkoutCalls()[0]));
    },
  );

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
    renderBillingTab();

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
    renderBillingTab();

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
    renderBillingTab();

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
    renderBillingTab();

    await screen.findAllByTestId("invoice-row");
    await submitAmount(actor, "0");

    await waitFor(() => {
      expect(screen.getByText(/Minimum amount is \$1/i)).toBeTruthy();
    });
    expect(checkoutCalls()).toHaveLength(0);
  });

  it("rejects sub-cent card amounts before reserving or posting", async () => {
    routeApi();
    renderBillingTab();
    await screen.findAllByTestId("invoice-row");

    submitFormAmount("1.001");

    expect(
      await screen.findByText("Amount must use exact whole cents"),
    ).toBeTruthy();
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
    renderBillingTab();

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
    renderBillingTab();
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
    renderBillingTab();
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
    let attempt = 0;
    routeApi(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("response lost"))
        : Promise.resolve({});
    });
    const firstRender = renderBillingTab();
    await screen.findAllByTestId("invoice-row");
    const actor = userEvent.setup();
    await submitAmount(actor, "25");
    await waitFor(() => expect(checkoutCalls()).toHaveLength(1));
    const originalKey = keyOf(checkoutCalls()[0]);

    firstRender.unmount();
    renderBillingTab();
    await screen.findAllByTestId("invoice-row");
    await submitAmount(actor, "25");
    await waitFor(() => expect(checkoutCalls()).toHaveLength(2));

    expect(keyOf(checkoutCalls()[1])).toBe(originalKey);
  });

  it("keeps card and crypto method toggles disabled while a card request is pending", async () => {
    const checkoutResponse = deferred<unknown>();
    const cryptoPayment = vi.fn();
    apiMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/invoices/list")) {
        return Promise.resolve({ invoices });
      }
      if (url.startsWith("/api/crypto/status")) {
        return Promise.resolve({
          enabled: true,
          directWallet: { enabled: false },
        });
      }
      if (url.startsWith("/api/stripe/create-checkout-session")) {
        return checkoutResponse.promise;
      }
      if (url.startsWith("/api/crypto/payments")) {
        cryptoPayment();
        return Promise.resolve({ payLink: "https://crypto.example.test" });
      }
      return Promise.resolve({});
    });
    const actor = userEvent.setup();
    renderBillingTab();
    await screen.findAllByTestId("invoice-row");
    const cardToggle = await screen.findByRole("button", { name: /^Card$/i });
    const cryptoToggle = screen.getByRole("button", { name: /^Crypto$/i });

    await submitAmount(actor, "25");
    await waitFor(() => expect(checkoutCalls()).toHaveLength(1));

    expect(cardToggle).toHaveProperty("disabled", true);
    expect(cryptoToggle).toHaveProperty("disabled", true);
    fireEvent.click(cryptoToggle);
    expect(cryptoToggle.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.queryByRole("button", { name: /Pay with Crypto/i }),
    ).toBeNull();
    expect(cryptoPayment).not.toHaveBeenCalled();

    await act(async () => {
      checkoutResponse.resolve({});
      await checkoutResponse.promise;
    });
    await waitFor(() => {
      expect(cardToggle).toHaveProperty("disabled", false);
      expect(cryptoToggle).toHaveProperty("disabled", false);
    });
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
    renderBillingTab();

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
