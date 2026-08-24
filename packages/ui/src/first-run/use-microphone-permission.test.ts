/** Verifies useMicrophonePermission through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Drives the real hook with mocks only at the platform boundary: the shared
 * `client` singleton stands in for the Electrobun/Capacitor permission
 * bridges, and `navigator.mediaDevices.getUserMedia` is stubbed for the
 * browser fallback probe. Every case asserts the controller state the
 * onboarding UI would render — never a mock's own bookkeeping.
 */

import type { PermissionId, PermissionState } from "@elizaos/shared";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  client: {
    requestPermission: vi.fn(),
    openPermissionSettings: vi.fn(),
  },
}));

import { client } from "../api";
import { useMicrophonePermission } from "./use-microphone-permission";

const requestPermission = vi.mocked(client.requestPermission);
const openPermissionSettings = vi.mocked(client.openPermissionSettings);

function permState(overrides: Partial<PermissionState> = {}): PermissionState {
  return {
    id: "microphone" as PermissionId,
    status: "granted",
    lastChecked: Date.now(),
    canRequest: true,
    platform: "darwin",
    ...overrides,
  };
}

function installMediaDevices(mediaDevices: unknown): void {
  Object.defineProperty(navigator, "mediaDevices", {
    value: mediaDevices,
    configurable: true,
  });
}

function streamWithTracks(count: number): {
  stops: Array<ReturnType<typeof vi.fn>>;
  stream: unknown;
} {
  const stops = Array.from({ length: count }, () => vi.fn());
  return {
    stops,
    stream: { getTracks: () => stops.map((stop) => ({ stop })) },
  };
}

/**
 * Simulates an older renderer whose bridge lacks the permission API: the hook
 * branches on `typeof client.requestPermission === "function"`, so both
 * methods are temporarily hidden. Restores them even when `run` throws.
 */
async function withoutClientPermissionApi(
  run: () => Promise<void>,
): Promise<void> {
  const holder = client as {
    requestPermission?: unknown;
    openPermissionSettings?: unknown;
  };
  const savedRequest = holder.requestPermission;
  const savedSettings = holder.openPermissionSettings;
  holder.requestPermission = undefined;
  holder.openPermissionSettings = undefined;
  try {
    await run();
  } finally {
    holder.requestPermission = savedRequest;
    holder.openPermissionSettings = savedSettings;
  }
}

const originalMediaDevices = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (originalMediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  } else {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  }
  cleanup();
});

describe("useMicrophonePermission", () => {
  it("starts in the actionable idle state with both controls exposed", () => {
    const { result } = renderHook(() => useMicrophonePermission());

    expect(result.current.status).toBe("unknown");
    expect(result.current.canRequest).toBe(true);
    expect(result.current.requesting).toBe(false);
    expect(typeof result.current.request).toBe("function");
    expect(typeof result.current.openSettings).toBe("function");
  });

  it("mirrors the platform client's granted result and releases the requesting flag", async () => {
    requestPermission.mockResolvedValue(
      permState({ status: "granted", canRequest: true }),
    );
    const { result } = renderHook(() => useMicrophonePermission());

    await act(async () => {
      await result.current.request();
    });

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(requestPermission).toHaveBeenCalledWith("microphone");
    expect(result.current.status).toBe("granted");
    expect(result.current.canRequest).toBe(true);
    expect(result.current.requesting).toBe(false);
  });

  it("passes a restricted client result through verbatim instead of recomputing it", async () => {
    requestPermission.mockResolvedValue(
      permState({ status: "restricted", canRequest: false }),
    );
    const { result } = renderHook(() => useMicrophonePermission());

    await act(async () => {
      await result.current.request();
    });

    expect(result.current.status).toBe("restricted");
    expect(result.current.canRequest).toBe(false);
    expect(result.current.requesting).toBe(false);
  });

  it("ignores overlapping requests while one is already in flight", async () => {
    let resolveFirst!: (value: PermissionState) => void;
    requestPermission.mockImplementationOnce(
      () =>
        new Promise<PermissionState>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const { result } = renderHook(() => useMicrophonePermission());
    const request = result.current.request;

    let inFlight!: Promise<void>;
    act(() => {
      inFlight = request();
    });
    expect(result.current.requesting).toBe(true);

    // A second invocation during flight must short-circuit, not queue.
    await act(async () => {
      await request();
    });

    resolveFirst(permState({ status: "granted", canRequest: true }));
    await act(async () => {
      await inFlight;
    });

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("granted");
    expect(result.current.canRequest).toBe(true);
    expect(result.current.requesting).toBe(false);
  });

  it("falls back to the getUserMedia probe when the client bridge throws", async () => {
    requestPermission.mockRejectedValue(new Error("bridge unavailable"));
    const { stops, stream } = streamWithTracks(2);
    const getUserMedia = vi.fn(async () => stream);
    installMediaDevices({ getUserMedia });
    const { result } = renderHook(() => useMicrophonePermission());

    await act(async () => {
      await result.current.request();
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    for (const stop of stops) {
      // The probe only wants the permission; every captured track is stopped.
      expect(stop).toHaveBeenCalledTimes(1);
    }
    expect(result.current.status).toBe("granted");
    expect(result.current.canRequest).toBe(true);
    expect(result.current.requesting).toBe(false);
  });

  it("reads a rejected getUserMedia probe as denied when the client bridge throws", async () => {
    requestPermission.mockRejectedValue(new Error("bridge unavailable"));
    installMediaDevices({
      getUserMedia: vi.fn(async () => {
        throw new Error("NotAllowedError");
      }),
    });
    const { result } = renderHook(() => useMicrophonePermission());

    await act(async () => {
      await result.current.request();
    });

    expect(result.current.status).toBe("denied");
    expect(result.current.canRequest).toBe(false);
    expect(result.current.requesting).toBe(false);
  });

  it("probes getUserMedia directly when the renderer has no permission client", async () => {
    const { stops, stream } = streamWithTracks(1);
    const getUserMedia = vi.fn(async () => stream);
    installMediaDevices({ getUserMedia });
    const { result } = renderHook(() => useMicrophonePermission());

    await withoutClientPermissionApi(async () => {
      await act(async () => {
        await result.current.request();
      });
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("granted");
    expect(result.current.canRequest).toBe(true);
  });

  it("reports not-applicable when navigator.mediaDevices is absent entirely", async () => {
    installMediaDevices(undefined);
    const { result } = renderHook(() => useMicrophonePermission());

    await withoutClientPermissionApi(async () => {
      await act(async () => {
        await result.current.request();
      });
    });

    expect(result.current.status).toBe("not-applicable");
    // Only an explicit denial disables further requests.
    expect(result.current.canRequest).toBe(true);
  });

  it("reports not-applicable when mediaDevices exists but exposes no getUserMedia", async () => {
    installMediaDevices({});
    const { result } = renderHook(() => useMicrophonePermission());

    await withoutClientPermissionApi(async () => {
      await act(async () => {
        await result.current.request();
      });
    });

    expect(result.current.status).toBe("not-applicable");
    expect(result.current.canRequest).toBe(true);
  });

  it("delegates openSettings to the platform deep link without touching state", async () => {
    const { result } = renderHook(() => useMicrophonePermission());

    await act(async () => {
      await result.current.openSettings();
    });

    expect(openPermissionSettings).toHaveBeenCalledTimes(1);
    expect(openPermissionSettings).toHaveBeenCalledWith("microphone");
    // No probe ran: state stays at its initial values.
    expect(result.current.status).toBe("unknown");
    expect(result.current.canRequest).toBe(true);
    expect(result.current.requesting).toBe(false);
  });

  it("survives a failing settings deep link without throwing or probing", async () => {
    openPermissionSettings.mockRejectedValue(new Error("no settings pane"));
    const { result } = renderHook(() => useMicrophonePermission());

    await act(async () => {
      await result.current.openSettings();
    });

    expect(result.current.status).toBe("unknown");
    expect(result.current.canRequest).toBe(true);
  });

  it("re-probes from openSettings when no client deep link exists (grant picked up)", async () => {
    const { stream } = streamWithTracks(1);
    const getUserMedia = vi.fn(async () => stream);
    installMediaDevices({ getUserMedia });
    const { result } = renderHook(() => useMicrophonePermission());

    await withoutClientPermissionApi(async () => {
      await act(async () => {
        await result.current.openSettings();
      });
    });

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("granted");
    expect(result.current.canRequest).toBe(true);
    expect(result.current.requesting).toBe(false);
  });

  it("lands an out-of-band denial as denied/cannot-request when re-probing from openSettings", async () => {
    installMediaDevices({
      getUserMedia: vi.fn(async () => {
        throw new Error("NotAllowedError");
      }),
    });
    const { result } = renderHook(() => useMicrophonePermission());

    await withoutClientPermissionApi(async () => {
      await act(async () => {
        await result.current.openSettings();
      });
    });

    expect(result.current.status).toBe("denied");
    expect(result.current.canRequest).toBe(false);
  });
});
