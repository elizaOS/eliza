// @vitest-environment jsdom
/**
 * The Domains tab rendered from the managed-domains route contract
 * (`GET /api/v1/apps/:id/domains`, `POST /domains/verify`).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CloudI18nProvider } from "../../shell/CloudI18nProvider";
import {
  AppDomains,
  type ManagedDomainRow,
} from "../components/app-domains";

const requests: string[] = [];
let listResponse: unknown;
let verifyResponse: unknown;

vi.mock("../../lib/api-client", () => ({
  api: async (path: string) => {
    const route = path.replace(/^\/api\/v1\/apps\/app-\d+/, "");
    requests.push(route);
    if (route === "/domains") {
      if (listResponse instanceof Error) throw listResponse;
      return listResponse;
    }
    if (route === "/domains/verify") return verifyResponse;
    return { success: true };
  },
}));

// Record rows render a desktop and a mobile copy.
const shown = (text: string) => screen.queryAllByText(text).length > 0;

const unverified: ManagedDomainRow = {
  id: "md-1",
  domain: "shop.example.com",
  registrar: "external",
  status: "pending",
  verified: false,
  sslStatus: "pending",
  expiresAt: null,
  cloudflareZoneId: null,
  verificationToken: "eliza-verify-test-fixture", // gitleaks:allow — fake fixture token
};
const purchased: ManagedDomainRow = {
  id: "md-0",
  domain: "bought.example.com",
  registrar: "cloudflare",
  status: "active",
  verified: true,
  sslStatus: "active",
  expiresAt: null,
  cloudflareZoneId: "zone-1",
  verificationToken: null,
};

afterEach(() => {
  requests.length = 0;
});

async function renderTab(response: unknown) {
  listResponse = response;
  const view = render(
    <CloudI18nProvider initialLang="en">
      <AppDomains appId="app-1" />
    </CloudI18nProvider>,
  );
  await waitFor(() =>
    expect(view.container.querySelector(".animate-pulse")).toBeNull(),
  );
  return view;
}

it("offers Add Domain when the app has no domain", async () => {
  const view = await renderTab({ success: true, domains: [] });
  expect(screen.getAllByText("Add Domain").length).toBeGreaterThan(0);
  expect(screen.queryByText("No App Deployed")).toBeNull();
  view.unmount();
});

it("keeps the TXT record after a Verify click that does not find it", async () => {
  verifyResponse = {
    success: true,
    domain: "shop.example.com",
    verified: false,
    error:
      "TXT record not found at _eliza-cloud-verify.shop.example.com — add it then retry",
  };
  const view = await renderTab({ success: true, domains: [unverified] });
  expect(shown("_eliza-cloud-verify.shop.example.com")).toBe(true);
  expect(shown("eliza-verify-test-fixture")).toBe(true);

  const verify = screen
    .getAllByRole("button")
    .find((button) => button.textContent?.trim() === "Verify");
  if (!verify) throw new Error("Verify button not rendered");
  fireEvent.click(verify);
  await waitFor(() => expect(requests).toContain("/domains/verify"));

  expect(shown("_eliza-cloud-verify.shop.example.com")).toBe(true);
  expect(shown("eliza-verify-test-fixture")).toBe(true);
  expect(
    await screen.findByText(/TXT record not found at _eliza-cloud-verify/),
  ).toBeTruthy();
  expect(requests).not.toContain("/domains/status");
  view.unmount();
});

it("keeps every attached domain visible and offers another attachment", async () => {
  const view = await renderTab({
    success: true,
    domains: [purchased, unverified],
  });
  expect(shown("shop.example.com")).toBe(true);
  expect(shown("bought.example.com")).toBe(true);
  expect(screen.getAllByText("Add Domain").length).toBeGreaterThan(0);
  view.unmount();
});

it("shows the request error when the domain list fails", async () => {
  const view = await renderTab(new Error("Request failed with status 500"));
  expect(screen.getByText("Could not load domains")).toBeTruthy();
  expect(screen.getByText("Request failed with status 500")).toBeTruthy();
  expect(screen.queryByText("Add Domain")).toBeNull();
  view.unmount();
});


it("shows each pending domain's TXT record and reports only the checked domain's failure", async () => {
  verifyResponse = { success: true, verified: false, error: "DNS proof missing" };
  const view = await renderTab({ success: true, domains: [unverified, { ...unverified, id: "md-2", domain: "second.example.com", verificationToken: "second-proof" }] });
  expect(shown("_eliza-cloud-verify.shop.example.com")).toBe(true);
  expect(shown("_eliza-cloud-verify.second.example.com")).toBe(true);
  const buttons = screen.getAllByRole("button").filter(button => button.textContent?.trim() === "Verify");
  fireEvent.click(buttons[0]);
  await screen.findByText("DNS proof missing");
  expect(screen.getAllByText("DNS proof missing")).toHaveLength(1);
  view.unmount();
});

it("does not present a failed list response as an empty successful list", async () => {
  const view = await renderTab({ success: false });
  expect(screen.getByText("Could not load domains")).toBeTruthy();
  expect(screen.queryByText("Add Domain")).toBeNull();
  view.unmount();
});

it("does not claim TLS is secured while a verified domain's certificate is pending", async () => {
  const view = await renderTab({ success: true, domains: [{ ...purchased, sslStatus: "pending" }] });
  expect(screen.queryByText("SSL/TLS Secured")).toBeNull();
  expect(screen.queryByText("76.76.21.21")).toBeNull();
  view.unmount();
});


it("does not publish the previous app's late domain response after navigation", async () => {
  let resolvePrevious!: (value: unknown) => void;
  listResponse = new Promise(resolve => { resolvePrevious = resolve; });
  const view = render(<CloudI18nProvider initialLang="en"><AppDomains appId="app-1" /></CloudI18nProvider>);
  listResponse = { success: true, domains: [] };
  view.rerender(<CloudI18nProvider initialLang="en"><AppDomains appId="app-2" /></CloudI18nProvider>);
  await screen.findByText("Use Your Own Domain");
  await act(async () => { resolvePrevious({ success: true, domains: [unverified] }); });
  expect(shown("shop.example.com")).toBe(false);
  view.unmount();
});
