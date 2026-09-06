/** Exercises one-time secret handling, explicit installation consent, and environment isolation through the real SDK with a deterministic HTTP boundary. */
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { notificationFixture } from "./app-notification-fixture";
import { AppNotificationSettings } from "./app-notification-settings";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
});
it("prepares a one-time secret but activates only after explicit server installation", async () => {
  const fixture = notificationFixture();
  render(
    <AppNotificationSettings
      client={fixture.client}
      appId="app-a"
      clientRegistrationId="client-test"
      environment="test"
    />,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Prepare signing key" }),
  );
  await screen.findByLabelText("New notification signing secret");
  expect(fixture.calls.some((call) => call.path.endsWith("/activate"))).toBe(
    false,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Activate installed signing key",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(sessionStorage.length).toBe(0);
  expect(localStorage.length).toBe(0);
  await user.click(
    screen.getByLabelText("I installed this pending key on my app server"),
  );
  await user.click(
    screen.getByRole("button", { name: "Activate installed signing key" }),
  );
  await screen.findByText("Signing key activated.");
  expect(
    fixture.calls.find((call) => call.path.endsWith("/activate"))?.body,
  ).toEqual({
    clientRegistrationId: "client-test",
    expectedRevision: "2",
    pendingKeyId: "pending-key-1",
  });
  expect(screen.queryByLabelText("New notification signing secret")).toBeNull();
});
it("clears disclosed keys across registrations and rejects a configuration from the wrong environment", async () => {
  const fixture = notificationFixture();
  const view = render(
    <AppNotificationSettings
      client={fixture.client}
      appId="app-a"
      clientRegistrationId="client-test"
      environment="test"
    />,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Prepare signing key" }),
  );
  await screen.findByLabelText("New notification signing secret");
  view.rerender(
    <AppNotificationSettings
      client={fixture.client}
      appId="app-a"
      clientRegistrationId="client-live"
      environment="live"
    />,
  );
  await screen.findByText(
    "Notification settings returned a different app or environment",
  );
  expect(screen.queryByLabelText("New notification signing secret")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Activate installed signing key" }),
  ).toBeNull();
});
it("saves the registered endpoint with its observed revision and retains unavailable reads as errors", async () => {
  const fixture = notificationFixture();
  render(
    <AppNotificationSettings
      client={fixture.client}
      appId="app-a"
      clientRegistrationId="client-test"
      environment="test"
    />,
  );
  const user = userEvent.setup();
  const input = await screen.findByLabelText(
    "App server notification endpoint",
  );
  await user.clear(input);
  await user.type(input, "https://app.example/api/subscriptions");
  await user.click(
    screen.getByRole("button", { name: "Save notification settings" }),
  );
  await screen.findByText("Notification settings saved.");
  expect(fixture.calls.find((call) => call.method === "POST")?.body).toEqual({
    clientRegistrationId: "client-test",
    expectedRevision: "1",
    endpointUrl: "https://app.example/api/subscriptions",
    enabled: false,
  });
  fixture.failure = true;
  await user.click(
    screen.getByRole("button", { name: "Refresh notification status" }),
  );
  await screen.findByRole("alert");
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Save notification settings",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true),
  );
});
