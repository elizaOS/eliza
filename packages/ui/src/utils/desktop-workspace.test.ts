/** Verifies the desktop workspace launcher uses one exact managed-shell RPC contract. */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { openDesktopWorkspaceWindow } from "./desktop-workspace";

interface DesktopBridgeTestWindow extends Window {
  __ELIZA_ELECTROBUN_RPC__?: {
    request: Record<string, (params?: unknown) => Promise<unknown>>;
    onMessage: () => void;
    offMessage: () => void;
  };
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const desktopWindow = {} as DesktopBridgeTestWindow;

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: desktopWindow,
  });
});

afterEach(() => {
  delete desktopWindow.__ELIZA_ELECTROBUN_RPC__;
  vi.restoreAllMocks();
});

afterAll(() => {
  if (originalWindow)
    Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("openDesktopWorkspaceWindow", () => {
  it("opens the canonical root shell with the stable dedupe slug", async () => {
    const open = vi.fn(async () => ({ id: "app_workspace" }));
    desktopWindow.__ELIZA_ELECTROBUN_RPC__ = {
      request: { desktopOpenAppWindow: open },
      onMessage: vi.fn(),
      offMessage: vi.fn(),
    };

    await openDesktopWorkspaceWindow();

    expect(open).toHaveBeenCalledWith({
      slug: "workspace",
      title: "Workspace",
      path: "/",
      alwaysOnTop: false,
    });
  });

  it("rejects when the native bridge is unavailable so callers can show an error", async () => {
    await expect(openDesktopWorkspaceWindow()).rejects.toThrow(
      "Desktop workspace bridge returned no managed window",
    );
  });

  it("rejects an empty native response instead of reporting a successful launch", async () => {
    desktopWindow.__ELIZA_ELECTROBUN_RPC__ = {
      request: { desktopOpenAppWindow: vi.fn(async () => undefined) },
      onMessage: vi.fn(),
      offMessage: vi.fn(),
    };

    await expect(openDesktopWorkspaceWindow()).rejects.toThrow(
      "Desktop workspace bridge returned no managed window",
    );
  });

  it.each([{}, { id: "" }, { id: "   " }, { id: 42 }])(
    "rejects malformed native window receipt %j",
    async (receipt) => {
      desktopWindow.__ELIZA_ELECTROBUN_RPC__ = {
        request: { desktopOpenAppWindow: vi.fn(async () => receipt) },
        onMessage: vi.fn(),
        offMessage: vi.fn(),
      };

      await expect(openDesktopWorkspaceWindow()).rejects.toThrow(
        "Desktop workspace bridge returned no managed window",
      );
    },
  );
});
