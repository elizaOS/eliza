/**
 * Verifies connector status is fetched again when a successful mutation
 * advances the refresh version supplied by the owning settings section.
 * @vitest-environment jsdom
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn(async () => ({ configured: false })),
}));

vi.mock("../cloud/lib/api-client", () => ({
  ApiError: class ApiError extends Error {},
  api: apiMock,
}));

import { useCloudConnectorConnections } from "./useCloudConnectorConnections";

describe("useCloudConnectorConnections refresh invalidation", () => {
  beforeEach(() => apiMock.mockClear());

  it("refetches when refreshVersion changes", async () => {
    const { rerender } = renderHook(
      ({ refreshVersion }) =>
        useCloudConnectorConnections({
          kind: "credential",
          statusPath: "/api/connectors/telegram/status",
          refreshVersion,
        }),
      { initialProps: { refreshVersion: 0 } },
    );

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    rerender({ refreshVersion: 1 });
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
  });
});
