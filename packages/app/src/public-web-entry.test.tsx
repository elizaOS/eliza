/**
 * Verifies the public renderer hands authenticated navigation to the full app
 * in the same browser document. The full renderer module is deterministic and
 * the public shell is reduced to its catch-all element.
 */
// @vitest-environment jsdom

import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const handoff = vi.hoisted(() => ({ fullAppLoads: 0 }));

vi.mock("@elizaos/ui/cloud/register-public", () => ({
  registerPublicCloudSurfaces: vi.fn(),
}));
vi.mock("@elizaos/ui/cloud/shell/CloudRouterShell", () => ({
  CloudRouterShell: ({ appElement }: { appElement: React.ReactNode }) =>
    appElement,
}));
vi.mock("./sw-registration", () => ({
  registerViewServiceWorker: vi.fn(),
}));
vi.mock("./main", () => {
  handoff.fullAppLoads += 1;
  const root = document.getElementById("root");
  if (root) root.textContent = "Full app mounted";
  return {};
});

describe("public renderer full-app handoff", () => {
  beforeEach(() => {
    handoff.fullAppLoads = 0;
    document.documentElement.dataset.documentIdentity = "original";
    document.body.innerHTML = '<div id="root"></div>';
  });

  it("loads the full renderer once without replacing the document", async () => {
    const originalDocument = document;
    await import("./public-web-entry");
    if (document.readyState === "loading") {
      document.dispatchEvent(new Event("DOMContentLoaded"));
    }

    await waitFor(() => expect(handoff.fullAppLoads).toBe(1));
    expect(document).toBe(originalDocument);
    expect(document.documentElement.dataset.documentIdentity).toBe("original");
    expect(document.getElementById("root")?.textContent).toBe(
      "Full app mounted",
    );
  });
});
