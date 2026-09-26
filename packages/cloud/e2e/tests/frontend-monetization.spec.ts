/**
 * Exercises authenticated Cloud management navigation against the real local
 * browser and API stack. Legacy dashboard links must reach their current page,
 * render its content, and successfully load that page's required API data.
 */
import { expect, test } from "../src/helpers/test-fixtures";

test.describe("cloud-frontend monetization pages", () => {
  test("legacy links render current management pages with authenticated data", async ({
    authenticatedPage: page,
    stack,
  }) => {
    const responses: Array<{ path: string; status: number }> = [];
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith("/api/"))
        responses.push({ path, status: response.status() });
    });

    const visit = async (
      from: string,
      destination: string,
      requiredApiPaths: string[],
      surface: "apps" | "analytics" | "billing" | "earnings",
    ) => {
      responses.length = 0;
      await Promise.all([
        ...requiredApiPaths.map((path) =>
          page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === path && response.ok(),
            { timeout: 45_000 },
          ),
        ),
        page.goto(`${stack.urls.frontend}${from}`, { timeout: 60_000 }),
      ]);
      await expect(page).toHaveURL(`${stack.urls.frontend}${destination}`);
      if (surface === "apps") {
        await expect(
          page.getByText("Total Apps", { exact: true }),
        ).toBeVisible();
      } else if (surface === "analytics") {
        await expect(
          page.getByRole("tab", { name: "Breakdown", exact: true }),
        ).toBeVisible();
      } else if (surface === "billing") {
        await expect(
          page.getByRole("heading", { name: "Active compute", exact: true }),
        ).toBeVisible();
      } else {
        await expect(
          page.getByRole("tab", { name: "Earnings", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByText("Available to Redeem", { exact: true }),
        ).toBeVisible();
      }
      expect(
        responses.filter((response) => response.status === 401),
        JSON.stringify(responses),
      ).toEqual([]);
    };

    await visit("/dashboard/apps", "/cloud/apps", ["/api/v1/apps"], "apps");
    await visit(
      "/dashboard/analytics",
      "/cloud/analytics",
      ["/api/analytics/breakdown", "/api/analytics/projections"],
      "analytics",
    );
    for (const query of ["", "?canceled=true"]) {
      await visit(
        `/dashboard/billing${query}`,
        `/cloud/billing${query}`,
        ["/api/v1/billing/limits"],
        "billing",
      );
    }
    for (const from of ["/dashboard/earnings", "/dashboard/monetization"]) {
      await visit(
        from,
        "/cloud/monetization",
        ["/api/v1/redemptions/balance"],
        "earnings",
      );
    }
    await visit(
      "/dashboard/settings?tab=billing",
      "/cloud/billing?tab=billing",
      ["/api/v1/billing/limits"],
      "billing",
    );
  });
});
