/**
 * Serves the built Connections bundle through the remote-view registry for
 * browser tests. Canonical server rewriting preserves the host-module import
 * boundary, and recorded requests prove the shell used that transport.
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import {
  parseHostExternalSpecifiers,
  wrapBundleAsHostExternalFactory,
} from "../../../agent/src/api/dynamic-view-host-external.mjs";

export async function installRemoteConnectionsView(page: Page) {
  const bundlePath = "/api/views/lifeops-connections/bundle.js";
  const bundleRequests: string[] = [];
  const source = readFileSync(
    new URL(
      "../../../../plugins/plugin-personal-assistant/dist/views/bundle.js",
      import.meta.url,
    ),
    "utf8",
  );
  await page.route(
    (url) => url.pathname === "/api/views",
    async (route) => {
      await route.fulfill({
        json: {
          views: [
            {
              id: "lifeops-connections",
              label: "Mail & Calendars",
              pluginName: "@elizaos/plugin-personal-assistant",
              path: "/lifeops/connections",
              viewType: "gui",
              componentExport: "LifeOpsConnectionsView",
              bundleUrl: bundlePath,
              available: true,
              surface: {
                header: "fullscreen",
                capabilities: ["agent-surface"],
              },
            },
          ],
        },
      });
    },
  );
  await page.context().route(
    (url) => url.pathname === bundlePath,
    async (route) => {
      const url = new URL(route.request().url());
      bundleRequests.push(url.href);
      const specifiers = parseHostExternalSpecifiers(url);
      await route.fulfill({
        contentType: "application/javascript",
        body: specifiers.length
          ? wrapBundleAsHostExternalFactory(source, specifiers)
          : source,
      });
    },
  );
  return { bundleRequests };
}
