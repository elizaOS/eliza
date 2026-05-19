// @vitest-environment jsdom

import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/runtime-mode-client", () => ({
  fetchRuntimeModeSnapshot: vi.fn(),
}));

import { fetchRuntimeModeSnapshot } from "../api/runtime-mode-client";
import {
  __resetRuntimeModeCacheForTests,
  useRuntimeMode,
} from "./useRuntimeMode";

const fetchMock = vi.mocked(fetchRuntimeModeSnapshot);

function HookProbe(props: {
  onState: (result: ReturnType<typeof useRuntimeMode>) => void;
}): null {
  const result = useRuntimeMode();
  props.onState(result);
  return null;
}

beforeEach(() => {
  __resetRuntimeModeCacheForTests();
  fetchMock.mockReset();
});

afterEach(() => {
  __resetRuntimeModeCacheForTests();
});

describe("useRuntimeMode", () => {
  it("starts in loading and resolves to a ready snapshot", async () => {
    fetchMock.mockResolvedValueOnce({
      mode: "cloud",
      deploymentRuntime: "cloud",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });

    const seen: ReturnType<typeof useRuntimeMode>[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);

    expect(seen[0]?.state.phase).toBe("loading");
    expect(seen[0]?.mode).toBeNull();

    await waitFor(() => {
      const last = seen[seen.length - 1];
      expect(last?.state.phase).toBe("ready");
    });
    const last = seen[seen.length - 1];
    if (!last || last.state.phase !== "ready") {
      throw new Error("expected ready state");
    }
    expect(last.state.snapshot.mode).toBe("cloud");
    expect(last.mode).toBe("cloud");
    expect(last.isCloudMode).toBe(true);
    expect(last.isLocalOnly).toBe(false);
    expect(last.isRemoteMode).toBe(false);
  });

  it("dedupes concurrent fetches and reuses the cached snapshot across mounts", async () => {
    fetchMock.mockResolvedValue({
      mode: "local-only",
      deploymentRuntime: "local",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });

    const firstSeen: ReturnType<typeof useRuntimeMode>[] = [];
    const { unmount } = render(
      <HookProbe onState={(r) => firstSeen.push(r)} />,
    );
    await waitFor(() =>
      expect(firstSeen[firstSeen.length - 1]?.state.phase).toBe("ready"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();

    const secondSeen: ReturnType<typeof useRuntimeMode>[] = [];
    render(<HookProbe onState={(r) => secondSeen.push(r)} />);
    // Cache hit — first observation is already ready, no second fetch.
    expect(secondSeen[0]?.state.phase).toBe("ready");
    expect(secondSeen[0]?.isLocalOnly).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable when the endpoint returns null", async () => {
    fetchMock.mockResolvedValueOnce(null);
    const seen: ReturnType<typeof useRuntimeMode>[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);
    await waitFor(() =>
      expect(seen[seen.length - 1]?.state.phase).toBe("unavailable"),
    );
    const last = seen[seen.length - 1];
    expect(last?.mode).toBeNull();
    expect(last?.isCloudMode).toBe(false);
  });

  it("refetch forces a new request after cache was reset", async () => {
    fetchMock.mockResolvedValueOnce({
      mode: "remote",
      deploymentRuntime: "remote",
      isRemoteController: true,
      remoteApiBaseConfigured: true,
    });
    const seen: ReturnType<typeof useRuntimeMode>[] = [];
    render(<HookProbe onState={(r) => seen.push(r)} />);
    await waitFor(() =>
      expect(seen[seen.length - 1]?.state.phase).toBe("ready"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce({
      mode: "local",
      deploymentRuntime: "local",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
    const last = seen[seen.length - 1];
    if (!last) throw new Error("hook never observed");
    await act(async () => {
      last.refetch();
    });
    await waitFor(() => {
      const cur = seen[seen.length - 1];
      if (!cur || cur.state.phase !== "ready") return;
      expect(cur.state.snapshot.mode).toBe("local");
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
