// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthMeResult } from "../api/auth-client";
import { authMe } from "../api/auth-client";
import { useAuthStatus } from "./useAuthStatus";

vi.mock("../api/auth-client", () => ({
  authMe: vi.fn(),
}));

function AuthStatusProbe() {
  const { state } = useAuthStatus({ pollIntervalMs: 0 });
  return <div data-testid="auth-phase">{state.phase}</div>;
}

describe("useAuthStatus", () => {
  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it("surfaces backend failures as server_unavailable instead of unauthenticated", async () => {
    vi.mocked(authMe).mockResolvedValue({
      ok: false,
      status: 503,
    } satisfies AuthMeResult);

    render(<AuthStatusProbe />);

    await waitFor(() =>
      expect(screen.getByTestId("auth-phase").textContent).toBe(
        "server_unavailable",
      ),
    );
  });
});
