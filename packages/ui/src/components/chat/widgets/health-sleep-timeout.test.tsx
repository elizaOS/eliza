/**
 * @vitest-environment jsdom
 *
 * HealthSleepWidget sleep JSON through the canonical ElizaClient seam.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { clientFetch } = vi.hoisted(() => ({
  clientFetch: vi.fn(),
}));

vi.mock("../../../api", () => ({
  client: {
    fetch: clientFetch,
    getBaseUrl: () => "http://test.local",
  },
}));

vi.mock("../../../api/app-shell-capabilities", () => ({
  supportsFullAppShellRoutes: () => true,
}));

vi.mock("../../../widgets/home-priority", () => ({
  HOME_SIGNAL_WEIGHTS: { "check-in": 1 },
}));

vi.mock("lucide-react", () => ({
  Moon: () => null,
}));

vi.mock("./home-widget-card", () => ({
  HomeWidgetCard: () => null,
  useWidgetNavigation: () => ({ openView: () => undefined }),
}));

vi.mock("../../../hooks", () => ({
  useIntervalWhenDocumentVisible: () => undefined,
}));

vi.mock("../../../hooks/useAuthStatus", () => ({
  useIsAuthenticated: () => false,
}));

vi.mock("../../../widgets/home-attention-store", () => ({
  usePublishHomeAttention: () => undefined,
}));

import {
  getHealthSleepJsonWithClient,
  HEALTH_SLEEP_JSON_TIMEOUT_MS,
} from "./health-sleep";

const PATH = "/api/lifeops/sleep/regularity?windowDays=14";

describe("HealthSleepWidget sleep JSON deadline", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("keeps a documented UI JSON budget", () => {
    expect(HEALTH_SLEEP_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("surfaces a timeout from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(
      new DOMException("The operation timed out", "TimeoutError"),
    );

    await expect(
      getHealthSleepJsonWithClient(PATH, { fetch: clientFetch }, 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(clientFetch).toHaveBeenCalledWith(PATH, undefined, {
      timeoutMs: 10,
    });
  });

  it("surfaces a provider error from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(
      new Error(`Sleep request failed (503): ${PATH}`),
    );

    await expect(
      getHealthSleepJsonWithClient(PATH, { fetch: clientFetch }, 1_000),
    ).rejects.toThrow("503");
  });

  it("uses the bounded client path for a successful sleep GET", async () => {
    clientFetch.mockResolvedValueOnce({ classification: "regular" });

    await expect(
      getHealthSleepJsonWithClient(PATH, { fetch: clientFetch }, 1_000),
    ).resolves.toEqual({ classification: "regular" });
    expect(clientFetch).toHaveBeenCalledWith(PATH, undefined, {
      timeoutMs: 1_000,
    });
  });
});
