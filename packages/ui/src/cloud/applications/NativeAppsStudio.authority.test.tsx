/** Exercises the real native studio, refresh request and secure persistence with held synthetic device transports. */
// @vitest-environment jsdom

import {
  clearStoredStewardToken,
  readStoredStewardToken,
  STEWARD_TOKEN_KEY,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  getStorageValue,
  initializeStorageBridge,
} from "../../bridge/storage-bridge";
import { setBootConfig } from "../../config/boot-config";
import { queryClient } from "../lib/query-client";
import NativeAppsStudio from "./NativeAppsStudio";

const device = vi.hoisted(() => ({
  values: new Map<string, string>(),
  request: vi.fn(),
  api: vi.fn(),
  heldToken: "",
  hold: null as Promise<void> | null,
  entered: false,
}));
vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: () => true,
      getPlatform: () => "android",
    },
    CapacitorHttp: { request: (...args: unknown[]) => device.request(...args) },
  };
});
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async () => ({ value: null }),
    set: async () => {},
    remove: async () => {},
  },
}));
vi.mock("@elizaos/capacitor-secure-store", () => ({
  ElizaSecureStore: {
    get: async ({ key }: { key: string }) =>
      device.values.has(key)
        ? { ok: true, value: device.values.get(key) }
        : { ok: false, error: "not_found" },
    set: async ({ key, value }: { key: string; value: string }) => {
      if (
        key === "session.steward_token" &&
        value === device.heldToken &&
        device.hold
      ) {
        device.entered = true;
        await device.hold;
      }
      device.values.set(key, value);
      return { ok: true };
    },
    remove: async ({ key }: { key: string }) => ({
      ok: true,
      deleted: device.values.delete(key),
    }),
  },
}));
vi.mock("../lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api-client")>()),
  api: (...args: unknown[]) => device.api(...args),
}));

function jwt(userId: string, seconds: number): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ userId, exp: Math.floor(Date.now() / 1000) + seconds })}.fixture`;
}

describe("native studio refresh ownership", () => {
  let oldToken: string;
  let freshToken: string;
  beforeAll(async () => {
    await initializeStorageBridge();
  });
  beforeEach(async () => {
    device.hold = null;
    device.heldToken = "";
    device.entered = false;
    device.request.mockReset();
    device.api.mockReset().mockResolvedValue({ apps: [] });
    vi.stubGlobal("Capacitor", { isNativePlatform: () => true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Unexpected real transport in studio fixture");
      }),
    );
    setBootConfig({ branding: {}, cloudApiBase: "https://api.eliza.app" });
    oldToken = jwt("studio-original", 30);
    freshToken = jwt("studio-original", 3600);
    await writeStoredStewardToken(oldToken);
    device.request.mockResolvedValue({
      status: 200,
      data: { token: freshToken },
    });
  });
  afterEach(async () => {
    cleanup();
    device.hold = null;
    await getStorageValue(STEWARD_TOKEN_KEY);
    queryClient.clear();
    vi.unstubAllGlobals();
    setBootConfig({ branding: {} });
  });

  it("persists a same-account refresh before opening the actual Applications list", async () => {
    render(<NativeAppsStudio />);
    await waitFor(() =>
      expect(device.api).toHaveBeenCalledWith("/api/v1/apps"),
    );
    expect(readStoredStewardToken()).toBe(freshToken);
    expect(device.values.get("session.steward_token")).toBe(freshToken);
    expect(screen.getByText("Total Apps")).toBeTruthy();
    expect(device.request).toHaveBeenCalledOnce();
  });

  it("completes the current mount under StrictMode without reviving the discarded effect", async () => {
    render(
      <StrictMode>
        <NativeAppsStudio />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(device.api).toHaveBeenCalledWith("/api/v1/apps"),
    );
    expect(readStoredStewardToken()).toBe(freshToken);
    expect(device.values.get("session.steward_token")).toBe(freshToken);
    expect(screen.getByText("Total Apps")).toBeTruthy();
  });

  it.each(["unmount", "pagehide", "target"])(
    "refuses a native write completed after %s",
    async (change) => {
      let release!: () => void;
      device.heldToken = freshToken;
      device.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const view = render(<NativeAppsStudio />);
      try {
        await waitFor(() => expect(device.entered).toBe(true));
        if (change === "unmount") view.unmount();
        else if (change === "pagehide")
          act(() => window.dispatchEvent(new Event("pagehide")));
        else
          setBootConfig({
            branding: {},
            cloudApiBase: "https://staging-api.eliza.app",
          });
        await act(async () => {
          release();
          await getStorageValue(STEWARD_TOKEN_KEY);
        });
        expect(device.values.get("session.steward_token")).toBe(oldToken);
        expect(readStoredStewardToken()).toBe(oldToken);
      } finally {
        release();
        view.unmount();
        await getStorageValue(STEWARD_TOKEN_KEY);
      }
    },
  );

  it("closes the authenticated list after canonical session removal without a legacy event", async () => {
    render(<NativeAppsStudio />);
    await waitFor(() =>
      expect(device.api).toHaveBeenCalledWith("/api/v1/apps"),
    );
    // Let the existing one-shot fallback read finish before ending this session.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
    });
    await act(async () => {
      await clearStoredStewardToken();
    });
    expect(
      await screen.findByText("Sign in to Eliza Cloud to manage Cloud Apps."),
    ).toBeTruthy();
    expect(screen.queryByText("Total Apps")).toBeNull();
  });

  it("renders the replacement account's inventory after a canonical session change", async () => {
    const replacement = jwt("studio-replacement", 3600);
    device.api.mockImplementation(async () => ({
      apps: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name:
            readStoredStewardToken() === replacement
              ? "Replacement account app"
              : "Original account app",
          app_url: "https://fixture.example.test",
          is_active: true,
          total_users: 1,
          total_requests: 1,
          updated_at: "2026-09-08T00:00:00.000Z",
        },
      ],
    }));
    render(<NativeAppsStudio />);
    expect(await screen.findByText("Original account app")).toBeTruthy();
    await act(async () => {
      await writeStoredStewardToken(replacement);
    });
    expect(await screen.findByText("Replacement account app")).toBeTruthy();
    expect(screen.queryByText("Original account app")).toBeNull();
  });

  it.each([
    ["hidden", "rejected"],
    ["hidden", "deadline"],
    ["refreshing", "rejected"],
    ["refreshing", "deadline"],
  ])(
    "closes the list when the session expires while %s and refresh is %s",
    async (phase, outcome) => {
      await writeStoredStewardToken(freshToken);
      let release: (() => void) | undefined;
      device.request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ status: 401, data: {} });
          }),
      );
      const view = render(<NativeAppsStudio />);
      const now = Date.now();
      const clock = vi.spyOn(Date, "now");
      try {
        expect(await screen.findByText("Total Apps")).toBeTruthy();
        expect(device.request).not.toHaveBeenCalled();
        act(() => window.dispatchEvent(new Event("pagehide")));
        clock.mockReturnValue(
          now + (phase === "hidden" ? 3_601_000 : 3_598_000),
        );
        act(() => window.dispatchEvent(new Event("pageshow")));
        await waitFor(() => expect(device.request).toHaveBeenCalledOnce());
        if (phase === "hidden") {
          expect(
            screen.getByText("Sign in to Eliza Cloud to manage Cloud Apps."),
          ).toBeTruthy();
          expect(screen.queryByText("Total Apps")).toBeNull();
        } else {
          expect(screen.getByText("Total Apps")).toBeTruthy();
          clock.mockReturnValue(now + 3_601_000);
        }
        await act(async () => {
          if (outcome === "deadline")
            await new Promise<void>((resolve) => setTimeout(resolve, 4_100));
          release?.();
        });
        expect(
          screen.getByText("Sign in to Eliza Cloud to manage Cloud Apps."),
        ).toBeTruthy();
        expect(screen.queryByText("Total Apps")).toBeNull();
        expect(readStoredStewardToken()).toBe(freshToken);
      } finally {
        release?.();
        view.unmount();
        clock.mockRestore();
        await getStorageValue(STEWARD_TOKEN_KEY);
      }
    },
    10000,
  );

  it("bounds the visible wait and rejects a native write that acknowledges after the deadline", async () => {
    let release!: () => void;
    device.heldToken = freshToken;
    device.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = render(<NativeAppsStudio />);
    try {
      await waitFor(() => expect(device.entered).toBe(true));
      await waitFor(() => expect(screen.getByText("Total Apps")).toBeTruthy(), {
        timeout: 5500,
      });
      await act(async () => {
        release();
        await getStorageValue(STEWARD_TOKEN_KEY);
      });
      expect(readStoredStewardToken()).toBe(oldToken);
      expect(device.values.get("session.steward_token")).toBe(oldToken);
    } finally {
      release();
      view.unmount();
      await getStorageValue(STEWARD_TOKEN_KEY);
    }
  }, 10000);

  it("starts a new page-return request only after the abandoned native request settles", async () => {
    let release!: (value: { status: number; data: { token: string } }) => void;
    device.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const view = render(<NativeAppsStudio />);
    try {
      await waitFor(() => expect(device.request).toHaveBeenCalledOnce());
      act(() => window.dispatchEvent(new Event("pagehide")));
      act(() => window.dispatchEvent(new Event("pageshow")));
      expect(device.request).toHaveBeenCalledOnce();
      expect(screen.queryByText("Total Apps")).toBeNull();
      await act(async () => {
        release({
          status: 200,
          data: { token: jwt("abandoned-fixture", 3600) },
        });
      });
      await waitFor(() => expect(device.request).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(device.api).toHaveBeenCalledWith("/api/v1/apps"),
      );
      expect(readStoredStewardToken()).toBe(freshToken);
      expect(device.values.get("session.steward_token")).toBe(freshToken);
    } finally {
      release({ status: 200, data: { token: freshToken } });
      view.unmount();
      await getStorageValue(STEWARD_TOKEN_KEY);
    }
  });

  it("preserves the selected detail tab and unsaved form across page-return refresh", async () => {
    const app = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Navigation fixture",
      app_url: "https://fixture.example.test",
      is_active: true,
      total_users: 1,
      total_requests: 1,
      updated_at: "2026-09-08T00:00:00.000Z",
    };
    device.api.mockImplementation(async (path: string) => {
      if (path === "/api/v1/apps") return { apps: [app] };
      if (path === `/api/v1/apps/${app.id}`) return { app };
      if (path.endsWith("/monetization"))
        return {
          success: true,
          monetization: { monetizationEnabled: false, totalCreatorEarnings: 0 },
        };
      throw new Error("Unexpected fixture inventory request");
    });
    const view = render(<NativeAppsStudio />);
    let release: (() => void) | undefined;
    try {
      fireEvent.click(
        await screen.findByRole("link", { name: "Navigation fixture" }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
      const input = await screen.findByRole("textbox", { name: "App Name" });
      fireEvent.change(input, { target: { value: "Unsaved fixture name" } });
      await act(async () => {
        await writeStoredStewardToken(oldToken);
      });
      device.heldToken = freshToken;
      device.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      act(() => window.dispatchEvent(new Event("pagehide")));
      act(() => window.dispatchEvent(new Event("pageshow")));
      await waitFor(() => expect(device.entered).toBe(true));
      await act(async () => {
        release?.();
        await getStorageValue(STEWARD_TOKEN_KEY);
      });
      const restored = await screen.findByRole<HTMLInputElement>("textbox", {
        name: "App Name",
      });
      expect(restored.value).toBe("Unsaved fixture name");
      expect(screen.queryByText("Total Apps")).toBeNull();
    } finally {
      release?.();
      view.unmount();
      await getStorageValue(STEWARD_TOKEN_KEY);
    }
  });

  it("does not publish an HTTP result for a replaced Cloud destination", async () => {
    let release!: (value: { status: number; data: { token: string } }) => void;
    device.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const view = render(<NativeAppsStudio />);
    try {
      await waitFor(() => expect(device.request).toHaveBeenCalledOnce());
      setBootConfig({
        branding: {},
        cloudApiBase: "https://staging-api.eliza.app",
      });
      await act(async () => {
        release({ status: 200, data: { token: freshToken } });
      });
      await waitFor(() => expect(screen.getByText("Total Apps")).toBeTruthy());
      expect(readStoredStewardToken()).toBe(oldToken);
      expect(device.values.get("session.steward_token")).toBe(oldToken);
    } finally {
      release({ status: 200, data: { token: freshToken } });
      view.unmount();
      await getStorageValue(STEWARD_TOKEN_KEY);
    }
  });
});
