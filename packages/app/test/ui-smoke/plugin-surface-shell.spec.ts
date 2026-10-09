/**
 * Exercises real Calendar, Cloud and Messages renderers with deterministic HTTP
 * feeds. Navigation has one owner, and short landscape screens must keep event
 * editing and the message composer reachable through ordinary scrolling.
 */
import { expect, test } from "@playwright/test";
import { findRemoteBundleDeclaration } from "./aesthetic-audit-rules";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { assertHeaderlessViewChrome } from "./helpers/view-header";

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  for (const view of [
    { name: "Calendar", path: "/calendar", root: "lifeops-calendar-section" },
    { name: "Eliza Cloud", path: "/cloud", root: "cloud-signed-out" },
  ]) {
    test(`${view.name} keeps its primary action reachable at ${viewport.width}px`, async ({
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
      await openAppPath(page, "/views");
      await openAppPath(page, routePath);
      await expect(page.getByTestId(view.root)).toBeVisible({
        timeout: 60_000,
      });
      if (view.path === "/calendar") {
        const create = page.getByRole("button", {
          name: "New event",
          exact: true,
        });
        await expect(create).toBeInViewport();
        await create.click();
        await expect(page.getByRole("dialog")).toBeVisible();
        const cancel = page.getByRole("button", {
          name: "Cancel event editor",
          exact: true,
        });
        await cancel.scrollIntoViewIfNeeded();
        await cancel.click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.getByTestId(view.root)).toBeVisible();
      } else {
        const connect = page.getByRole("button", {
          name: "Connect in Settings",
          exact: true,
        });
        await expect(connect).toBeInViewport();
        await connect.click();
        await expect(page).toHaveURL(/\/settings(?:[?#]|$)/);
        await expect(page.getByTestId("settings-shell")).toBeVisible();
        await expect(page.getByTestId(view.root)).toHaveCount(0);
      }
      await openAppPath(page, "/views");
      await openAppPath(page, routePath);
      await assertHeaderlessViewChrome(page);
      await page.goBack();
      await expect(page).toHaveURL(/\/views(?:[?#]|$)/);
      await expect(page.getByTestId(view.root)).toHaveCount(0);
    });
  }
}

test("Calendar landscape scrolling exposes an event for opening", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/calendar");
  await expect(page.getByTestId("lifeops-calendar-section")).toBeVisible();
  const event = page.getByRole("button", { name: /Design sync/ }).first();
  await expect(event).toBeAttached();
  const beforeScroll = await event.boundingBox();
  if (!beforeScroll)
    throw new Error("Calendar event must have laid-out geometry");
  await page.mouse.move(400, 260);
  // Bring the 9 AM event toward the middle of this short screen. A fixed
  // 500px wheel delta overshoots it into the afternoon after header removal.
  await page.mouse.wheel(0, Math.max(40, beforeScroll.y - 170));
  await expect
    .poll(
      async () => (await event.boundingBox())?.y ?? Number.POSITIVE_INFINITY,
    )
    .toBeLessThan(beforeScroll.y);
  await expect(event).toBeInViewport({ ratio: 1 });
  await event.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const cancel = page.getByRole("button", {
    name: "Cancel event editor",
    exact: true,
  });
  await cancel.scrollIntoViewIfNeeded();
  await expect(cancel).toBeInViewport();
  await cancel.click({ timeout: 15_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Messages landscape keeps status separate and composer reachable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await seedAppStorage(page);
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/messages");
  const status = page.getByText("bridge-only", { exact: true });
  const role = page.getByRole("button", {
    name: "Set default SMS",
    exact: true,
  });
  await expect(status).toBeVisible();
  await expect(role).toBeVisible();
  const statusBox = await status.boundingBox();
  const roleBox = await role.boundingBox();
  if (!statusBox || !roleBox)
    throw new Error("Messages status controls are not laid out");
  expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(roleBox.y);
  await page.mouse.move(400, 260);
  await page.mouse.wheel(0, 500);
  const address = page.getByRole("textbox", { name: "To", exact: true });
  const body = page.getByRole("textbox", { name: "Body", exact: true });
  await expect(body).toBeInViewport();
  await address.fill("+15550101234");
  await body.fill("Layout regression draft");
  await expect(address).toHaveValue("+15550101234");
  await expect(body).toHaveValue("Layout regression draft");
  await expect(
    page.getByRole("button", { name: "Send SMS", exact: true }),
  ).toBeEnabled();
});

for (const width of [1440, 390]) {
  test(`plugin transport and account stay textual and port stays numeric at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await seedAppStorage(page);
    await installDefaultAppRoutes(page);
    await page.route("**/api/plugins", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          plugins: [
            {
              id: "review-config",
              name: "Connection settings",
              description: "Transport and port configuration",
              enabled: true,
              configured: true,
              envKey: null,
              category: "feature",
              source: "bundled",
              validationErrors: [],
              validationWarnings: [],
              parameters: [
                {
                  key: "IMESSAGE_TRANSPORT",
                  type: "string",
                  description: "Transport: native or blooio",
                  required: false,
                  sensitive: false,
                },
                {
                  key: "HEDERA_ACCOUNT_ID",
                  type: "string",
                  description: "Account identifier",
                  required: false,
                  sensitive: false,
                },
                {
                  key: "SERVER_PORT",
                  type: "string",
                  description: "Server listener port",
                  required: false,
                  sensitive: false,
                },
              ],
            },
          ],
        }),
      }),
    );
    await openAppPath(page, "/apps/plugins");
    await page.locator('li[data-plugin-id="review-config"]').click();
    const transport = page
      .locator("#field-review-config-IMESSAGE_TRANSPORT")
      .getByRole("textbox");
    await expect(transport).toHaveAttribute("type", "text");
    await transport.fill("blooio");
    await expect(transport).toHaveValue("blooio");
    await expect(transport).not.toHaveAttribute("min", "1");
    await expect(transport).not.toHaveAttribute("max", "65535");
    const account = page
      .locator("#field-review-config-HEDERA_ACCOUNT_ID")
      .getByRole("textbox");
    await expect(account).toHaveAttribute("type", "text");
    await account.fill("0.0.12345");
    await expect(account).toHaveValue("0.0.12345");
    await expect(account).not.toHaveAttribute("min", "0");
    const port = page.getByRole("dialog").getByRole("spinbutton");
    await expect(port).toHaveAttribute("min", "1");
    await expect(port).toHaveAttribute("max", "65535");
    await port.fill("8080");
    await expect(port).toHaveValue("8080");
    await page.screenshot({
      path: testInfo.outputPath(`plugin-port-${width}.jpg`),
      type: "jpeg",
      fullPage: true,
    });
  });
}
