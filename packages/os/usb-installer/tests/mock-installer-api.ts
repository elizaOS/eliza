import type { Page, Route } from "@playwright/test";

export const mockDrive = {
  id: "fake-usb",
  name: "elizaOS Test USB",
  devicePath: "/dev/sdz",
  sizeBytes: 16 * 1024 ** 3,
  bus: "usb",
  platform: "linux",
  safety: "safe-removable",
  description: "Playwright mock removable drive",
};

export const mockImage = {
  id: "elizaos-stable",
  label: "elizaOS Live",
  version: "2026.05.19",
  channel: "stable",
  architecture: "x86_64",
  buildId: "playwright",
  publishedAt: "2026-05-19T00:00:00.000Z",
  url: "https://download.elizaos.ai/elizaos-live.iso",
  checksumSha256:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  sizeBytes: 4 * 1024 ** 3,
  minUsbSizeBytes: 8 * 1024 ** 3,
  manifestVersion: 1,
};

export interface MockInstallerApiCalls {
  planRequests: unknown[];
  executeRequests: unknown[];
}

export async function mockInstallerApi(
  page: Page,
): Promise<MockInstallerApiCalls> {
  const calls: MockInstallerApiCalls = {
    planRequests: [],
    executeRequests: [],
  };

  await page.route("**/api/drives", async (route) => {
    await route.fulfill({ json: [mockDrive] });
  });

  await page.route("**/api/images", async (route) => {
    await route.fulfill({ json: [mockImage] });
  });

  await page.route("**/api/plan", async (route) => {
    const request = route.request().postDataJSON();
    calls.planRequests.push(request);
    await route.fulfill({
      json: {
        planId: request.dryRun ? undefined : "playwright-plan-id",
        request,
        drive: mockDrive,
        image: mockImage,
        privilegedWriteImplemented: true,
        steps: [
          {
            id: "resolve-image",
            label: "Resolve image",
            status: request.dryRun ? "complete" : "pending",
            detail: request.dryRun
              ? "Dry-run complete; no bytes were written."
              : "Waiting to start.",
          },
          {
            id: "checksum",
            label: "Validate checksum",
            status: request.dryRun ? "complete" : "pending",
            detail: request.dryRun
              ? "Dry-run complete; no bytes were written."
              : "Waiting to start.",
          },
          {
            id: "write",
            label: "Write image",
            status: request.dryRun ? "complete" : "pending",
            detail: request.dryRun
              ? "Dry-run complete; no bytes were written."
              : "Waiting to start.",
          },
          {
            id: "verify",
            label: "Verify media",
            status: request.dryRun ? "complete" : "pending",
            detail: request.dryRun
              ? "Dry-run complete; no bytes were written."
              : "Waiting to start.",
          },
          {
            id: "complete",
            label: "Complete",
            status: request.dryRun ? "complete" : "pending",
            detail: request.dryRun
              ? "Dry-run complete; no bytes were written."
              : "Waiting to start.",
          },
        ],
      },
    });
  });

  await page.route("**/api/execute", async (route: Route) => {
    calls.executeRequests.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: "text/event-stream",
      body: [
        'data: {"stepId":"resolve-image","progress":1}',
        'data: {"stepId":"checksum","progress":1}',
        'data: {"stepId":"write","progress":1}',
        'data: {"stepId":"verify","progress":1}',
        'data: {"stepId":"complete","progress":1}',
        'data: {"done":true}',
        "",
      ].join("\n\n"),
    });
  });

  return calls;
}
