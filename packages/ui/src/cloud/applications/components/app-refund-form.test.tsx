/** Exercises merchant refund review and durable recovery through the rendered catalog and real SDK with controlled HTTP responses. */
// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { catalogFixture } from "./app-catalog-fixture";
import { AppCatalogSettings } from "./app-catalog-settings";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
function fixture() {
  const value = catalogFixture();
  value.payments.push({
    id: "period-1",
    accountName: "Research workspace",
    planName: "Team",
    periodStart: "2026-08-01T00:00:00Z",
    periodEnd: "2026-09-01T00:00:00Z",
    quantity: 3,
    refundOperations: [],
  });
  return value;
}
function receipt(environment: "test" | "live" = "test") {
  return {
    id: "refund-command",
    status: "refund" as const,
    receipt: {
      refundId: "re_one",
      paidPeriodId: "period-1",
      amountCents: 500,
      currency: "usd",
      environment,
      accessPolicy: "preserve" as const,
      providerStatus: "pending" as const,
    },
  };
}
function mount(value: ReturnType<typeof fixture>) {
  return render(
    <AppCatalogSettings client={value.client} appId="app-a" userId="user-a" />,
  );
}
async function review() {
  const user = userEvent.setup();
  await user.selectOptions(
    await screen.findByLabelText("App client and billing environment"),
    "client-test",
  );
  await user.click(
    await screen.findByRole("button", { name: "Review payment" }),
  );
  const amount = await screen.findByLabelText("Refund amount in USD cents");
  await user.clear(amount);
  await user.type(amount, "500");
  await user.click(screen.getByRole("button", { name: "Review refund" }));
  return user;
}
it("does not refund during preview and submits one explicit preserve-access confirmation", async () => {
  const value = fixture();
  value.result = receipt();
  mount(value);
  const user = await review();
  expect(value.calls.some((call) => call.path.endsWith("/refunds"))).toBe(
    false,
  );
  const confirmation = screen.getByRole("group", { name: "Confirm refund" });
  expect(
    within(confirmation).getByText(
      /Refund \$5\.00 to the original payment method/,
    ),
  ).toBeTruthy();
  await user.dblClick(
    within(confirmation).getByRole("button", {
      name: "Confirm refund and keep access",
    }),
  );
  await screen.findByRole("heading", { name: "Refund pending" });
  const writes = value.calls.filter((call) => call.path.endsWith("/refunds"));
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({
    paidPeriodId: "period-1",
    clientRegistrationId: "client-test",
    amountCents: 500,
    accessPolicy: "preserve",
    confirmation: "refund_original_payment_preserve_access",
  });
  expect(screen.queryByRole("group", { name: "Confirm refund" })).toBeNull();
});
it("retains the exact refund intent across a lost response and remount", async () => {
  const value = fixture();
  const view = mount(value);
  const user = await review();
  value.failure = "uncertain";
  await user.click(
    screen.getByRole("button", { name: "Confirm refund and keep access" }),
  );
  await screen.findByText(/Response lost after creation request was sent/);
  const original = value.calls.find((call) =>
    call.path.endsWith("/refunds"),
  )?.body;
  expect(original).toBeTruthy();
  view.unmount();
  value.result = receipt();
  mount(value);
  await user.selectOptions(
    await screen.findByLabelText("App client and billing environment"),
    "client-test",
  );
  await user.click(
    await screen.findByRole("button", { name: "Recover saved request" }),
  );
  await screen.findByRole("heading", { name: "Refund pending" });
  const requests = value.calls.filter((call) => call.path.endsWith("/refunds"));
  expect(requests).toHaveLength(2);
  expect(requests[1].body).toEqual(original);
});
it("retains uncertain intent when a receipt belongs to another billing environment", async () => {
  const value = fixture();
  value.result = receipt("live");
  mount(value);
  const user = await review();
  await user.click(
    screen.getByRole("button", { name: "Confirm refund and keep access" }),
  );
  await screen.findByText(
    "Refund receipt differs from the selected payment and environment",
  );
  expect(
    screen.getByRole("button", { name: "Recover saved request" }),
  ).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Refund pending" })).toBeNull();
});
it("recovers refund history after browser storage is gone without submitting another refund", async () => {
  const value = fixture();
  value.result = receipt();
  value.payments[0].refundOperations.push({
    id: "refund-command",
    amountCents: 500,
    state: "receipt_available",
    createdAt: "2026-09-05T12:00:00Z",
  });
  mount(value);
  const user = userEvent.setup();
  await user.selectOptions(
    await screen.findByLabelText("App client and billing environment"),
    "client-test",
  );
  await user.click(
    await screen.findByRole("button", { name: "View refund status" }),
  );
  await waitFor(() =>
    expect(
      value.calls.some((call) => call.path.endsWith("/refund-command/recover")),
    ).toBe(true),
  );
  await screen.findByRole("heading", { name: "Refund pending" });
  expect(value.calls.some((call) => call.path.endsWith("/refunds"))).toBe(
    false,
  );
});
