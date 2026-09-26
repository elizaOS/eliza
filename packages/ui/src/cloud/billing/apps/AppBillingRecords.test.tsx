/** Exercises pagination and seat authorization through the real SDK HTTP boundary. */
// @vitest-environment jsdom

import { CloudApiClient } from "@elizaos/cloud-sdk";
import { AppBillingClient } from "@elizaos/cloud-sdk/app-billing";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { AppBillingRecords } from "./AppBillingRecords";

afterEach(cleanup);
it("loads additional records only on request and scopes seat assignment to the app account", async () => {
  const requests: { url: URL; body: Record<string, unknown> | null }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body =
      request.method === "GET"
        ? null
        : ((await request.json()) as Record<string, unknown>);
    requests.push({ url, body });
    if (body)
      return Response.json({
        success: true,
        data: { id: "seat-2", subject: body.subject, assignedAt: "2026-09-05" },
      });
    const data = url.pathname.endsWith("/invoices")
      ? {
          items: [
            {
              id: url.searchParams.has("cursor") ? "invoice-2" : "invoice-1",
              status: "paid",
              amountPaidCents: 1800,
              amountDueCents: 0,
              currency: "usd",
              periodStart: url.searchParams.has("cursor")
                ? "2026-09-01"
                : "2026-08-01",
              periodEnd: "2026-10-01",
              hostedInvoiceUrl: null,
            },
          ],
          nextCursor: url.searchParams.has("cursor") ? null : "page-two",
        }
      : { items: [], nextCursor: null };
    return Response.json({ success: true, data });
  };
  const client = new AppBillingClient(
    new CloudApiClient("https://fixture.example/api/v1", undefined, {
      fetchImpl,
    }),
    "app-a",
  );
  render(
    <AppBillingRecords
      client={client}
      accountId="account-1"
      productFamilyKey="workspace"
      administrator
    />,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Load more invoices" }),
  );
  await waitFor(() =>
    expect(
      requests.some(
        (request) => request.url.searchParams.get("cursor") === "page-two",
      ),
    ).toBe(true),
  );
  await user.type(screen.getByLabelText("App member identifier"), "member-7");
  await user.click(screen.getByRole("button", { name: "Assign seat" }));
  await waitFor(() =>
    expect(requests.find((request) => request.body)?.body).toMatchObject({
      subject: "member-7",
    }),
  );
  expect(requests.find((request) => request.body)?.url.pathname).toBe(
    "/api/v1/apps/app-a/billing/accounts/account-1/subscriptions/workspace/seats",
  );
});
