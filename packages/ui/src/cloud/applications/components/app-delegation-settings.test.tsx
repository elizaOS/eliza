/** Exercises owner client registration and rotation through the real SDK with a deterministic HTTP boundary. */
// @vitest-environment jsdom
import { CloudApiClient } from "@elizaos/cloud-sdk";
import {
  AppDelegationManagementClient,
  type AppDelegationRegistration,
} from "@elizaos/cloud-sdk/app-delegation";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { AppDelegationSettings } from "./app-delegation-settings";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
});
function fixture() {
  const requests: {
    method: string;
    path: string;
    body: Record<string, unknown> | null;
  }[] = [];
  const clients: AppDelegationRegistration[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body =
      request.method === "POST"
        ? ((await request.json()) as Record<string, unknown>)
        : null;
    requests.push({ method: request.method, path, body });
    if (request.method === "GET")
      return Response.json({ success: true, data: clients });
    if (request.method === "DELETE") return Response.json({ success: true });
    if (!path.endsWith("/rotate"))
      clients.push({
        clientId: "client-1",
        billingEnvironment: "test",
        billingReturnUrl: null,
        redirectUris: ["https://app.example/callback"],
        allowedScopes: ["identity"],
        revision: 1,
        active: true,
        createdAt: "2026-09-05T12:00:00Z",
      });
    return Response.json({
      success: true,
      data: {
        clientId: "client-1",
        clientSecret: "one-time-fixture-secret",
        revision: 1,
        billingEnvironment: "test",
      },
    });
  };
  return {
    requests,
    clients,
    client: new AppDelegationManagementClient(
      new CloudApiClient("https://fixture.example/api/v1", undefined, {
        fetchImpl,
      }),
      "app-1",
    ),
  };
}
it("registers only selected capabilities and never persists the disclosed secret", async () => {
  const data = fixture();
  render(<AppDelegationSettings client={data.client} appName="Field Notes" />);
  await screen.findByText("No registered app clients.");
  const user = userEvent.setup();
  await user.type(
    screen.getByLabelText("Exact HTTPS return URLs, one per line"),
    "https://app.example/callback",
  );
  await user.type(
    screen.getByLabelText("Billing return URL"),
    "https://app.example/#/settings",
  );
  await user.click(
    screen.getByLabelText("Read your subscriptions and invoices for this app"),
  );
  await user.click(
    screen.getByRole("button", { name: "Register test client" }),
  );
  await screen.findByRole("region", { name: "New client secret" });
  expect(data.requests.find((item) => item.method === "POST")?.body).toEqual({
    billingEnvironment: "test",
    billingReturnUrl: "https://app.example/#/settings",
    redirectUris: ["https://app.example/callback"],
    allowedScopes: ["identity", "billing:read"],
  });
  expect(sessionStorage.length).toBe(0);
  expect(localStorage.length).toBe(0);
  await user.click(screen.getByRole("button", { name: "I saved the secret" }));
  expect(screen.queryByLabelText("New client secret")).toBeNull();
});
it("requires confirmation before rotating a secret and invalidating existing user grants", async () => {
  const data = fixture();
  data.clients.push({
    clientId: "client-1",
    billingEnvironment: "test",
    billingReturnUrl: null,
    redirectUris: ["https://app.example/callback"],
    allowedScopes: ["identity"],
    revision: 1,
    active: true,
    createdAt: "2026-09-05T12:00:00Z",
  });
  render(<AppDelegationSettings client={data.client} appName="Field Notes" />);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", {
      name: "Rotate secret for test client",
    }),
  );
  expect(data.requests.filter((item) => item.method === "POST")).toHaveLength(
    0,
  );
  await user.click(screen.getByRole("button", { name: "Confirm rotation" }));
  await waitFor(() =>
    expect(
      data.requests.some((item) => item.path.endsWith("/client-1/rotate")),
    ).toBe(true),
  );
});
