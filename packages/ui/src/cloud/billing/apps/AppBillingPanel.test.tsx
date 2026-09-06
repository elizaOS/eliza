/** Exercises buyer interactions through the real Cloud SDK and an explicit HTTP fixture, including uncertain command recovery. */
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AppBillingPanel } from "./AppBillingPanel";
import { billingFixture } from "./billing-fixture";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
function mount(fixture = billingFixture()) {
  return {
    fixture,
    ...render(
      <AppBillingPanel
        client={fixture.client}
        appId={fixture.catalog.appId}
        productFamilyKey="workspace"
        userId="buyer"
        storage={sessionStorage}
      />,
    ),
  };
}
describe("independent app subscription UI", () => {
  it("requires purchase review and explicit consent before dispatching checkout", async () => {
    const { fixture } = mount();
    await screen.findByText("Field Notes subscription");
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Review subscription" }),
    );
    expect(
      fixture.calls.filter((call) => call.path.endsWith("/checkout")),
    ).toHaveLength(0);
    await user.click(
      screen.getByRole("button", { name: "Agree and continue to payment" }),
    );
    await waitFor(() =>
      expect(
        fixture.calls.find((call) => call.path.endsWith("/checkout"))?.body,
      ).toMatchObject({
        billingConsent: "accepted",
        expectedSubscriptionRevision: null,
        quantity: 1,
        planRevisionId: "plan-1",
      }),
    );
  });
  it("preserves the same purchase key and payload after an uncertain response and remount", async () => {
    const fixture = billingFixture();
    fixture.failure = "uncertain";
    const view = mount(fixture);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Start seven-day trial" }),
    );
    await screen.findByText("Connection interrupted after request dispatch");
    const original = fixture.calls.find((call) =>
      call.path.endsWith("/trial"),
    )?.body;
    view.unmount();
    mount(fixture);
    await waitFor(() =>
      expect(
        fixture.calls.filter((call) => call.path.endsWith("/trial")),
      ).toHaveLength(2),
    );
    expect(
      fixture.calls.filter((call) => call.path.endsWith("/trial"))[1].body,
    ).toEqual(original);
  });
  it("retains an earlier lost purchase through an ambiguous authority rejection", async () => {
    const fixture = billingFixture();
    fixture.failure = "uncertain";
    const first = mount(fixture);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Start seven-day trial" }),
    );
    await screen.findByText("Connection interrupted after request dispatch");
    const sent = fixture.calls.find((call) => call.path.endsWith("/trial"));
    if (!sent) throw new Error("The original purchase was not dispatched");
    const original = sent.body;
    first.unmount();
    fixture.failure = "authority";
    const second = mount(fixture);
    await screen.findByText("Subscription request rejected");
    second.unmount();
    fixture.failure = "none";
    mount(fixture);
    await waitFor(() =>
      expect(
        fixture.calls.filter((call) => call.path.endsWith("/trial")),
      ).toHaveLength(3),
    );
    expect(
      fixture.calls
        .filter((call) => call.path.endsWith("/trial"))
        .map((call) => call.body),
    ).toEqual([original, original, original]);
  });
  it("releases a saved review only after a confirmed unexecuted rejection", async () => {
    const fixture = billingFixture();
    fixture.failure = "not_applied";
    const first = mount(fixture);
    await userEvent
      .setup()
      .click(
        await screen.findByRole("button", { name: "Start seven-day trial" }),
      );
    await screen.findByText("Subscription request rejected");
    first.unmount();
    fixture.failure = "none";
    mount(fixture);
    await screen.findByRole("button", { name: "Start seven-day trial" });
    expect(
      fixture.calls.filter((call) => call.path.endsWith("/trial")),
    ).toHaveLength(1);
  });
  it("recovers a server pending checkout when browser storage is empty", async () => {
    const fixture = billingFixture();
    const operation = {
      id: "pending-1",
      appId: "app-a",
      environment: "test" as const,
      billingAccountId: "account-1",
      productFamilyKey: "workspace",
      status: "requires_action" as const,
      action: {
        kind: "checkout" as const,
        url: "https://checkout.example/session",
        expiresAt: null,
      },
    };
    fixture.snapshot = { ...fixture.snapshot, pendingOperation: operation };
    fixture.operation = operation;
    mount(fixture);
    expect(
      (
        await screen.findByRole("link", { name: "Continue to payment" })
      ).getAttribute("href"),
    ).toBe("https://checkout.example/session");
    expect(
      screen
        .getByRole("button", { name: "Review subscription" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      fixture.calls.filter((call) => call.path.endsWith("/checkout")),
    ).toHaveLength(0);
  });
  it("resumes payment authentication from the server operation without submitting another upgrade or checkout cancellation", async () => {
    const fixture = billingFixture();
    const operation = {
      id: "upgrade-payment",
      appId: "app-a",
      environment: "test" as const,
      billingAccountId: "account-1",
      productFamilyKey: "workspace",
      status: "requires_action" as const,
      action: {
        kind: "payment" as const,
        url: "https://invoice.stripe.com/i/original",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    };
    fixture.snapshot = { ...fixture.snapshot, pendingOperation: operation };
    fixture.operation = operation;
    mount(fixture);
    expect(
      (
        await screen.findByRole("link", { name: "Authenticate payment" })
      ).getAttribute("href"),
    ).toBe(operation.action.url);
    expect(
      screen.queryByRole("button", { name: "Cancel this checkout" }),
    ).toBeNull();
    const before = fixture.calls.length;
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Check payment status" }));
    await waitFor(() => expect(fixture.calls.length).toBeGreaterThan(before));
    expect(
      fixture.calls.filter((call) =>
        /\/(update|checkout|expire)$/.test(call.path),
      ),
    ).toHaveLength(0);
    expect(fixture.calls.some((call) => call.path.includes(operation.id))).toBe(
      true,
    );
  });
  it("requests a quote for the selected seats and confirms its revision before an update", async () => {
    const fixture = billingFixture();
    fixture.snapshot = { ...fixture.snapshot, mutationRevision: "4" };
    mount(fixture);
    const user = userEvent.setup();
    await screen.findByText("Field Notes subscription");
    fireEvent.change(screen.getByLabelText("Seats (1–20)"), {
      target: { value: "3" },
    });
    await user.click(
      screen.getByRole("button", { name: "Review plan and seats" }),
    );
    await screen.findByText("Due now: $9.00");
    expect(
      fixture.calls.filter((call) => call.path.endsWith("/update")),
    ).toHaveLength(0);
    await user.click(
      screen.getByRole("button", { name: "Confirm plan change" }),
    );
    await waitFor(() =>
      expect(
        fixture.calls.find((call) => call.path.endsWith("/update"))?.body,
      ).toMatchObject({
        quoteId: "quote-1",
        expectedSubscriptionRevision: "4",
        quantity: 3,
        billingConsent: "accepted",
      }),
    );
  });
  it("does not show an empty healthy subscription or enable payment after a read failure", async () => {
    const fixture = billingFixture();
    fixture.failure = "read";
    mount(fixture);
    await screen.findByRole("alert");
    expect(screen.queryByText("No subscription")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Start seven-day trial" }),
    ).toBeNull();
  });
  it("keeps account members read-only and shows expired access explicitly", async () => {
    const fixture = billingFixture();
    fixture.snapshot = {
      ...fixture.snapshot,
      account: { ...fixture.snapshot.account, role: "member" },
      entitlement: {
        access: "read_only",
        featureKeys: [],
        sourceSubscriptionRevision: "2",
        seatCapacity: 2,
        assignedSeats: 1,
        validUntil: "2099-01-01T00:00:00Z",
      },
    };
    mount(fixture);
    await screen.findByText("Read-only access · New activity is unavailable");
    expect(
      screen
        .getByRole("button", { name: "Review subscription" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
  it("clears previous app state when the same host switches apps", async () => {
    const first = billingFixture();
    const second = billingFixture({
      appId: "app-b",
      appName: "Studio",
      environment: "live",
    });
    const { rerender } = mount(first);
    await screen.findByText("Field Notes subscription");
    rerender(
      <AppBillingPanel
        client={second.client}
        appId="app-b"
        userId="buyer"
        productFamilyKey="workspace"
        storage={sessionStorage}
      />,
    );
    await screen.findByText("Studio subscription");
    expect(screen.queryByText("Field Notes subscription")).toBeNull();
    expect(
      screen.queryByText(
        "Test environment · No live app access or live charges",
      ),
    ).toBeNull();
  });
});
