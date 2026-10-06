// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMock = vi.hoisted(() => ({
  streamStatus: vi.fn(),
  streamGoLive: vi.fn(),
  streamGoOffline: vi.fn(),
}));
const resourceMock = vi.hoisted(() => ({
  cachedStatus: undefined as
    | {
        data: {
          running: boolean;
          ffmpegAlive: boolean;
          uptime: number;
          frameCount: number;
        };
      }
    | undefined,
}));

vi.mock("../../api/client", () => ({ client: clientMock }));
vi.mock("../../bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => true,
}));
vi.mock("../../config/boot-config-store", () => ({
  getBootConfig: () => ({ branding: { appName: "Eliza" }, apiBase: "/api" }),
}));
vi.mock("../../hooks/resource-cache", () => ({
  getCached: () => resourceMock.cachedStatus,
  setCached: () => {},
}));
vi.mock("../../hooks/useDocumentVisibility", () => ({
  useIntervalWhenDocumentVisible: () => {},
}));
vi.mock("../../state/app-store", () => ({
  useAppSelectorShallow: (selector: (state: unknown) => unknown) =>
    selector({
      agentStatus: { agentName: "Eliza" },
      t: (_key: string, options?: { defaultValue?: string }) =>
        options?.defaultValue ?? _key,
    }),
}));
vi.mock("../stream/StatusBar", () => ({
  StatusBar: ({
    onToggleStream,
    streamLive,
    streamLoading,
  }: {
    onToggleStream: () => void;
    streamLive: boolean;
    streamLoading: boolean;
  }) => (
    <button type="button" disabled={streamLoading} onClick={onToggleStream}>
      {streamLive ? "Stop Stream" : "Go Live"}
    </button>
  ),
}));
vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children: ReactNode }) => children,
}));

import { StreamView } from "./StreamView";

beforeEach(() => {
  vi.clearAllMocks();
  resourceMock.cachedStatus = undefined;
  clientMock.streamStatus.mockResolvedValue({
    running: false,
    ffmpegAlive: false,
    uptime: 0,
    frameCount: 0,
  });
  clientMock.streamGoLive.mockResolvedValue({ live: true });
  clientMock.streamGoOffline.mockResolvedValue({ live: false });
});

afterEach(cleanup);

describe("StreamView action failures", () => {
  it("shows a failed Go Live request until a successful retry", async () => {
    clientMock.streamGoLive
      .mockRejectedValueOnce(new Error("Encoder unavailable"))
      .mockResolvedValueOnce({ live: true });
    render(<StreamView />);

    fireEvent.click(await screen.findByRole("button", { name: "Go Live" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Encoder unavailable",
    );

    fireEvent.click(screen.getByRole("button", { name: "Go Live" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(
      screen
        .getByRole("button", { name: "Stop Stream" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("shows a failed Stop Stream request and keeps the reconciled live state", async () => {
    resourceMock.cachedStatus = {
      data: {
        running: true,
        ffmpegAlive: true,
        uptime: 10,
        frameCount: 20,
      },
    };
    clientMock.streamStatus.mockResolvedValue({
      running: true,
      ffmpegAlive: true,
      uptime: 10,
      frameCount: 20,
    });
    clientMock.streamGoOffline.mockRejectedValue(
      new Error("Streaming service unavailable"),
    );
    render(<StreamView />);

    fireEvent.click(await screen.findByRole("button", { name: "Stop Stream" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Streaming service unavailable",
    );
    expect(
      screen
        .getByRole("button", { name: "Stop Stream" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});
