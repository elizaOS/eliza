// @vitest-environment jsdom
/**
 * App launch and run surfaces stay off when the agent has no run API, detached
 * overlay windows translate, the catalog loader shares the AOSP gate, and the
 * viewer auth handshake survives remounts and refuses opaque-origin frames.
 */
import type { RegistryAppInfo } from "@elizaos/core/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const views = vi.hoisted(() => ({ fail: false }));

vi.mock("../../../hooks/useAvailableViews", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../hooks/useAvailableViews")>();
  return {
    ...actual,
    fetchAvailableViews: async () => {
      if (views.fail) throw new Error("views endpoint returned 500");
      return [];
    },
  };
});

vi.mock("../../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../../../state/useApp", () => ({
  useApp: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
  }),
}));

import { ApiError } from "../../../api/api-error";
import { client } from "../../../api/client";
import { registerOverlayApp } from "../../../apps/overlay-app-registry";
import { AppWindowRenderer } from "../AppWindowRenderer";
import { RegistryAppWindowView } from "../AppWindowRenderer.routes";
import {
  APP_RUN_API_UNSUPPORTED_MESSAGE,
  resetAppRunApiProbeForTests,
} from "../app-run-api";
import { EmbeddedAppViewer } from "../EmbeddedAppViewer";
import { FullscreenView } from "../FullscreenView";
import { GameViewOverlay } from "../GameViewOverlay";
import { loadAppsCatalog } from "../load-apps-catalog";
import {
  sanitizeGameViewerSandbox,
  VIEWER_AUTH_BLOCKED_MESSAGE,
} from "../viewer-auth";

function catalogApp(
  name: string,
  launchType: RegistryAppInfo["launchType"],
): RegistryAppInfo {
  return {
    name,
    displayName: name,
    description: "",
    category: "utility",
    launchType,
    launchUrl: null,
    icon: null,
    heroImage: null,
    capabilities: [],
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: false, v1: false, v2: true },
    npm: { package: name, v0Version: null, v1Version: null, v2Version: null },
  } as RegistryAppInfo;
}

function runApiAbsent() {
  vi.spyOn(client, "listAppRuns").mockRejectedValue(
    new ApiError({
      kind: "http",
      path: "/api/apps/runs",
      status: 404,
      message: "Not found",
    }),
  );
}

let launchApp: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetAppRunApiProbeForTests();
  views.fail = false;
  vi.spyOn(client, "getBaseUrl").mockReturnValue("");
  launchApp = vi.fn(async () => ({}));
  vi.spyOn(client, "launchApp").mockImplementation(launchApp as never);
  vi.spyOn(client, "listApps").mockResolvedValue([]);
  vi.spyOn(client, "listCatalogApps").mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("app run API gate", () => {
  it("renders unsupported launch and run surfaces and sends no launch", async () => {
    runApiAbsent();
    vi.mocked(client.listCatalogApps).mockResolvedValue([
      catalogApp("@example/app-chess", "url"),
    ]);
    render(<RegistryAppWindowView slug="chess" />);
    expect(
      await screen.findByText(APP_RUN_API_UNSUPPORTED_MESSAGE),
    ).toBeTruthy();
    cleanup();

    render(<FullscreenView />);
    expect(screen.getByRole("alert").textContent).toBe(
      APP_RUN_API_UNSUPPORTED_MESSAGE,
    );
    const overlay = render(<GameViewOverlay />);
    expect(overlay.container.innerHTML).toBe("");
    expect(launchApp).not.toHaveBeenCalled();
  });

  it("launches when the agent answers the run list", async () => {
    vi.spyOn(client, "listAppRuns").mockResolvedValue([]);
    vi.mocked(client.listCatalogApps).mockResolvedValue([
      catalogApp("@example/app-chess", "url"),
    ]);
    render(<RegistryAppWindowView slug="chess" />);
    await vi.waitFor(() =>
      expect(launchApp).toHaveBeenCalledWith("@example/app-chess"),
    );
  });

  it("probes again when the client switches agents", async () => {
    runApiAbsent();
    vi.mocked(client.listCatalogApps).mockResolvedValue([
      catalogApp("@example/app-chess", "url"),
    ]);
    render(<RegistryAppWindowView slug="chess" />);
    expect(
      await screen.findByText(APP_RUN_API_UNSUPPORTED_MESSAGE),
    ).toBeTruthy();
    vi.mocked(client.getBaseUrl).mockReturnValue("http://agent-two.test");
    vi.mocked(client.listAppRuns).mockResolvedValue([]);
    act(() => {
      (
        client as unknown as { notifyAuthorityChange(): void }
      ).notifyAuthorityChange();
    });
    await vi.waitFor(() =>
      expect(launchApp).toHaveBeenCalledWith("@example/app-chess"),
    );
  });
});

describe("detached app windows", () => {
  it("renders translated strings in a detached overlay window", async () => {
    runApiAbsent();
    registerOverlayApp({
      name: "@example/app-translated",
      displayName: "Translated",
      description: "",
      category: "utility",
      icon: null,
      Component: ({ t }) => (
        <span>{t("example.new", { defaultValue: "New contact" })}</span>
      ),
    });
    render(<AppWindowRenderer slug="translated" />);
    expect(await screen.findByText("New contact")).toBeTruthy();
    expect(screen.queryByText("example.new")).toBeNull();
  });

  it("falls through to the catalog view once a non-overlay slug is known", async () => {
    runApiAbsent();
    vi.mocked(client.listCatalogApps).mockResolvedValue([
      catalogApp("@example/app-notes", "url"),
    ]);
    const started = Date.now();
    render(<AppWindowRenderer slug="notes" />);
    expect(
      await screen.findByText(APP_RUN_API_UNSUPPORTED_MESSAGE, undefined, {
        timeout: 3000,
      }),
    ).toBeTruthy();
    // Well inside the 8 s overlay registration window.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("waits for overlay registration before falling through for an overlay entry", async () => {
    runApiAbsent();
    vi.mocked(client.listCatalogApps).mockResolvedValue([
      catalogApp("@example/app-late", "overlay"),
    ]);
    render(<AppWindowRenderer slug="late" />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(screen.queryByText(APP_RUN_API_UNSUPPORTED_MESSAGE)).toBeNull();
    registerOverlayApp({
      name: "@example/app-late",
      displayName: "Late",
      description: "",
      category: "utility",
      icon: null,
      Component: () => <span>Late overlay</span>,
    });
    expect(await screen.findByText("Late overlay")).toBeTruthy();
    expect(launchApp).not.toHaveBeenCalled();
  });
});

describe("loadAppsCatalog", () => {
  it("strips androidOnly apps outside AOSP and survives a view-list error", async () => {
    views.fail = true;
    registerOverlayApp({
      name: "@example/app-wifi",
      displayName: "WiFi",
      description: "",
      category: "system",
      icon: null,
      androidOnly: true,
      Component: () => <span>WiFi</span>,
    });
    vi.mocked(client.listCatalogApps).mockResolvedValue([
      catalogApp("@example/app-wifi", "url"),
      catalogApp("@example/app-chess", "url"),
    ]);
    vi.mocked(client.listApps).mockResolvedValue([
      catalogApp("@example/app-wifi", "url"),
    ]);
    const names = (await loadAppsCatalog()).map((app) => app.name);
    expect(names).toContain("@example/app-chess");
    expect(names).not.toContain("@example/app-wifi");
  });
});

describe("viewer auth handshake", () => {
  const viewerUrl = "https://viewer.example/app";
  const authMessage = { type: "FEED_AUTH", token: "synthetic" } as never;

  function postReady(source: Window) {
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "FEED_READY" },
          origin: "https://viewer.example",
          source,
        }),
      );
    });
  }

  it("sends the auth payload again to a remounted or reloaded frame", () => {
    const view = render(
      <EmbeddedAppViewer
        key="first"
        viewerUrl={viewerUrl}
        authMessage={authMessage}
        title="Feed"
      />,
    );
    const first = screen.getByTestId(
      "embedded-app-viewer-iframe",
    ) as HTMLIFrameElement;
    const firstWindow = first.contentWindow as Window;
    const firstPost = vi.spyOn(firstWindow, "postMessage");
    postReady(firstWindow);
    // A frame that reloads itself keeps its window and asks again.
    postReady(firstWindow);
    expect(firstPost).toHaveBeenCalledTimes(2);
    expect(firstPost).toHaveBeenLastCalledWith(
      authMessage,
      "https://viewer.example",
    );

    view.rerender(
      <EmbeddedAppViewer
        key="second"
        viewerUrl={viewerUrl}
        authMessage={authMessage}
        title="Feed"
      />,
    );
    const second = screen.getByTestId(
      "embedded-app-viewer-iframe",
    ) as HTMLIFrameElement;
    const secondWindow = second.contentWindow as Window;
    expect(secondWindow).not.toBe(firstWindow);
    const secondPost = vi.spyOn(secondWindow, "postMessage");
    postReady(secondWindow);
    expect(secondPost).toHaveBeenCalledWith(
      authMessage,
      "https://viewer.example",
    );
  });

  it("shows unsupported for a postMessage-auth viewer on the shell origin", () => {
    const sameOriginUrl = `${window.location.origin}/api/apps/feed/viewer`;
    const sandbox = sanitizeGameViewerSandbox(undefined, sameOriginUrl);
    expect(sandbox.split(" ")).not.toContain("allow-same-origin");
    render(
      <EmbeddedAppViewer
        viewerUrl={sameOriginUrl}
        authMessage={authMessage}
        sandbox={sandbox}
        title="Feed"
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe(
      VIEWER_AUTH_BLOCKED_MESSAGE,
    );
    expect(screen.queryByTestId("embedded-app-viewer-iframe")).toBeNull();
  });
});
