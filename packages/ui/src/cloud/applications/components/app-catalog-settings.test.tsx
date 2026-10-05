/** Exercises environment selection, durable command recovery, and explicit catalog confirmation through the real SDK with a deterministic HTTP boundary. */
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { catalogFixture } from "./app-catalog-fixture";
import { AppCatalogSettings } from "./app-catalog-settings";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
async function selectTest() {
  const user = userEvent.setup();
  await user.selectOptions(
    await screen.findByLabelText("App client and billing environment"),
    "client-test",
  );
  return user;
}
it("keeps live merchants and unfinished commands out of a test registration while exposing pending creation after reload", async () => {
  const fixture = catalogFixture();
  fixture.data.operations.push(
    {
      id: "command-test",
      action: "plan_create",
      status: "outcome_unknown",
      createdAt: "2026-09-05T12:00:00Z",
      environment: "test",
      clientRegistrationId: "client-test",
    },
    {
      id: "command-live",
      action: "merchant_create",
      status: "pending",
      createdAt: "2026-09-05T12:00:00Z",
      environment: "live",
      clientRegistrationId: "client-live",
    },
  );
  render(
    <AppCatalogSettings
      client={fixture.client}
      appId="app-a"
      userId="user-a"
    />,
  );
  const user = await selectTest();
  expect(screen.getByText(/Provider result unknown/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Recover merchant create" }),
  ).toBeNull();
  expect(
    (
      screen.getByRole("button", {
        name: "Register merchant",
      }) as HTMLButtonElement
    ).disabled ||
      (
        screen
          .getByRole("button", { name: "Register merchant" })
          .closest("fieldset") as HTMLFieldSetElement
      ).disabled,
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Recover plan create" }));
  await waitFor(() =>
    expect(
      fixture.calls.some((call) => call.path.endsWith("/command-test/recover")),
    ).toBe(true),
  );
  await user.selectOptions(
    screen.getByLabelText("App client and billing environment"),
    "client-live",
  );
  expect(screen.queryByText("merchant-test")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Recover merchant create" }),
  ).toBeTruthy();
});
it("reuses the exact merchant intent after a lost response and a remount, without exposing it to another app", async () => {
  const fixture = catalogFixture();
  fixture.failure = "uncertain";
  const view = render(
    <AppCatalogSettings
      client={fixture.client}
      appId="app-a"
      userId="user-a"
    />,
  );
  const user = await selectTest();
  await user.type(screen.getByLabelText("Country code"), "US");
  await user.click(screen.getByRole("button", { name: "Register merchant" }));
  await screen.findByText(/Response lost/);
  const original = fixture.calls.find((call) => call.method === "POST")?.body;
  view.unmount();
  const other = catalogFixture("app-b");
  const otherView = render(
    <AppCatalogSettings client={other.client} appId="app-b" userId="user-a" />,
  );
  await selectTest();
  expect(
    screen.queryByRole("button", { name: "Recover saved request" }),
  ).toBeNull();
  otherView.unmount();
  render(
    <AppCatalogSettings
      client={fixture.client}
      appId="app-a"
      userId="user-a"
    />,
  );
  await selectTest();
  await user.click(
    await screen.findByRole("button", { name: "Recover saved request" }),
  );
  await waitFor(() =>
    expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(
      2,
    ),
  );
  expect(
    fixture.calls.filter((call) => call.method === "POST")[1].body,
  ).toEqual(original);
  await waitFor(() => expect(sessionStorage.length).toBe(0));
});
it("confirms publication and merchant disconnection before submitting their mutations", async () => {
  const fixture = catalogFixture();
  render(
    <AppCatalogSettings
      client={fixture.client}
      appId="app-a"
      userId="user-a"
    />,
  );
  const user = await selectTest();
  await user.click(screen.getByRole("button", { name: "Publish Team" }));
  expect(fixture.calls.filter((call) => call.method === "POST")).toHaveLength(
    0,
  );
  await user.click(screen.getByRole("button", { name: "Confirm publish" }));
  await waitFor(() =>
    expect(
      fixture.calls.some((call) => call.path.endsWith("/plans/publish")),
    ).toBe(true),
  );
  await user.click(screen.getByRole("button", { name: "Disable new sales" }));
  expect(
    fixture.calls.filter((call) => call.path.endsWith("/disconnect")),
  ).toHaveLength(0);
  await user.click(
    screen.getByRole("button", { name: "Confirm disable new sales" }),
  );
  await screen.findByText(
    "New sales disabled. 4 existing subscriptions continue billing.",
  );
  expect(
    fixture.calls.find((call) => call.path.endsWith("/disconnect"))?.body,
  ).toMatchObject({
    clientRegistrationId: "client-test",
    expectedRevision: "1",
    confirmation: "disable_new_sales_for_merchant",
  });
});
it("submits the selected plan terms and literal seven-day trial without publishing the draft", async () => {
  const fixture = catalogFixture();
  render(
    <AppCatalogSettings
      client={fixture.client}
      appId="app-a"
      userId="user-a"
    />,
  );
  const user = await selectTest();
  await user.selectOptions(
    screen.getByLabelText("Verified merchant for a new plan"),
    "merchant-test",
  );
  for (const [label, value] of [
    ["Plan name", "Research"],
    ["Product family key", "workspace"],
    ["Plan key", "research"],
    ["Price per seat in USD cents", "2500"],
  ])
    await user.type(screen.getByLabelText(label), value);
  await user.clear(screen.getByLabelText("Maximum seats"));
  await user.type(screen.getByLabelText("Maximum seats"), "12");
  await user.click(screen.getByRole("button", { name: "Create plan draft" }));
  await waitFor(() =>
    expect(fixture.calls.some((call) => call.path.endsWith("/plans"))).toBe(
      true,
    ),
  );
  expect(
    fixture.calls.find((call) => call.path.endsWith("/plans"))?.body,
  ).toMatchObject({
    merchantId: "merchant-test",
    clientRegistrationId: "client-test",
    amountCents: 2500,
    seats: { minimum: 1, maximum: 12 },
    trial: { days: 7, allowanceUsd: "0.00" },
    expiredAccess: "read_only",
  });
  expect(fixture.calls.some((call) => call.path.endsWith("/publish"))).toBe(
    false,
  );
});
it("renders unavailable capabilities distinctly and disables stale actions after a failed refresh", async () => {
  const fixture = catalogFixture();
  fixture.data.merchants[0].capabilities = null;
  fixture.data.merchants[0].requirementsDue = null;
  fixture.data.merchants[0].connectionStatus = "pending";
  render(
    <AppCatalogSettings
      client={fixture.client}
      appId="app-a"
      userId="user-a"
    />,
  );
  const user = await selectTest();
  expect(
    screen.getByText("Provider capabilities have not been verified."),
  ).toBeTruthy();
  expect(
    screen.queryByText("No outstanding provider requirements."),
  ).toBeNull();
  fixture.failure = "read";
  await user.click(screen.getByRole("button", { name: "Refresh catalog" }));
  await screen.findByRole("alert");
  expect(
    (screen.getByRole("button", { name: "Publish Team" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
