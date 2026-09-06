/**
 * Exercises the real Calendar and Cloud renderers under the smoke server's registered
 * surface contract. Desktop and mobile must have one navigation owner; its
 * back control must remain reachable and return to the launcher.
 */
import { expect, test } from "@playwright/test";
import { findRemoteBundleDeclaration } from "./aesthetic-audit-rules";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  for (const view of [
    { name: "Calendar", path: "/calendar", root: "lifeops-calendar-section" },
    { name: "Eliza Cloud", path: "/cloud", root: "cloud-signed-out" },
  ]) {
    test(`${view.name} owns its header and back navigation at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await seedAppStorage(page);
      await installDefaultAppRoutes(page);
      let routePath = view.path;
      if (view.path === "/cloud") {
        // /cloud belongs to the separate account control plane. Mount the
        // registered plugin bundle through the same isolated route used by
        // the visual audit, preserving its production surface metadata.
        const response = await page.request.get("/api/views");
        expect(response.ok()).toBe(true);
        const payload: unknown = await response.json();
        const registered = findRemoteBundleDeclaration(payload, "cloud", "gui");
        if (
          !registered ||
          !payload ||
          typeof payload !== "object" ||
          !("views" in payload) ||
          !Array.isArray(payload.views)
        )
          throw new Error("Missing registered Cloud renderer");
        routePath = "/__audit/plugin-view/cloud";
        const registry = {
          ...payload,
          views: payload.views.map((entry: unknown) =>
            entry &&
            typeof entry === "object" &&
            "id" in entry &&
            entry.id === registered.id
              ? { ...entry, path: routePath }
              : entry,
          ),
        };
        await page.route("**/api/views", (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(registry),
          }),
        );
      }
      await openAppPath(page, routePath);
      await expect(page.getByTestId(view.root)).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      const back = page.getByRole("button", {
        name: "Back to launcher",
        exact: true,
      });
      await expect(back).toHaveCount(1);
      await expect(back).toBeInViewport();
      await back.click();
      await expect(page).toHaveURL(/\/views(?:[?#]|$)/);
      await expect(page.getByTestId(view.root)).toHaveCount(0);
    });
  }
}
