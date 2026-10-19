/** CLI handoff state boundaries; deterministic session/API doubles, no real grants. */
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authenticated: false,
  ready: true,
  complete: vi.fn(),
}));
vi.mock("../../../lib/use-session-auth", () => ({
  useSessionAuth: () => ({
    authenticated: state.authenticated,
    ready: state.ready,
  }),
}));
vi.mock("../../../lib/api-client", () => ({
  apiFetch: state.complete,
  ApiError: class extends Error {},
}));
vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options: { defaultValue?: string }) =>
    options.defaultValue ?? _key,
}));
vi.mock("../../../shell/StewardProvider", () => ({
  clearStaleStewardSession: vi.fn(),
}));
vi.mock("../../../cloud-auth-complete-signal", () => ({
  hasCloudAuthCompleted: () => false,
  isCloudAuthHandoffSurface: () => false,
  publishCloudAuthComplete: vi.fn(),
  subscribeCloudAuthComplete: () => () => {},
}));

import CliLoginPage, { AlphaCliLoginPage } from "./cli-login-page";

const SESSION = "45da6fcb-524c-441c-b71e-26bd7eb686fa";
function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}
function mount(alpha = true, query = `session=${SESSION}`) {
  return render(
    <MemoryRouter
      initialEntries={[
        `${alpha ? "/alpha/auth/cli-login" : "/auth/cli-login"}?${query}`,
      ]}
    >
      <Routes>
        <Route path="/alpha/auth/cli-login" element={<AlphaCliLoginPage />} />
        <Route path="/auth/cli-login" element={<CliLoginPage />} />
        <Route path="/alpha/sign-in" element={<LocationProbe />} />
        <Route path="/login" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  state.authenticated = false;
  state.ready = true;
  state.complete.mockReset();
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(cleanup);

describe("CLI sign-in presentation and consent", () => {
  it.each([
    { alpha: true, hint: "", path: "/alpha/sign-in" },
    { alpha: false, hint: "", path: "/login" },
    { alpha: false, hint: "&app=alpha", path: "/alpha/sign-in" },
    { alpha: false, hint: "&app=other", path: "/login" },
    { alpha: false, hint: "&app=ALPHA", path: "/login" },
  ])(
    "keeps canonical continuation for Alpha route=$alpha hint=$hint",
    async ({ alpha, hint, path }) => {
      const query = `session=${SESSION}&returnTo=${encodeURIComponent("https://example.invalid/app?x=1&y=2")}${hint}`;
      mount(alpha, query);
      const location = await screen.findByTestId("location");
      const url = new URL(location.textContent ?? "", "https://eliza.app");
      expect(url.pathname).toBe(path);
      expect(url.searchParams.get("returnTo")).toBe(
        `/auth/cli-login?${new URLSearchParams(query)}`,
      );
      expect(state.complete).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])(
    "does not authorize on page load or cancel with Alpha route=%s",
    async (alpha) => {
      state.authenticated = true;
      mount(alpha, `session=${SESSION}&app=alpha`);
      await screen.findByRole("button", { name: "Authorize" });
      expect(state.complete).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await screen.findByText(
        "No API key was created and the requesting app was not granted access.",
      );
      expect(state.complete).not.toHaveBeenCalled();
    },
  );
  it.each([true, false])(
    "completes the same session only after Authorize with Alpha route=%s",
    async (alpha) => {
      state.authenticated = true;
      state.complete.mockResolvedValue(
        new Response(JSON.stringify({ keyPrefix: "qa-prefix" }), {
          status: 200,
        }),
      );
      mount(alpha, `session=${SESSION}&app=alpha`);
      expect(state.complete).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole("button", { name: "Authorize" }));
      await waitFor(() => expect(state.complete).toHaveBeenCalledTimes(1));
      expect(state.complete).toHaveBeenCalledWith(
        `/api/auth/cli-session/${SESSION}/complete`,
        expect.objectContaining({ method: "POST", json: {} }),
      );
    },
  );
  it.each([true, false])(
    "does not begin login or authorize invalid session with Alpha route=%s",
    async (alpha) => {
      mount(alpha, "session=not-a-session&app=alpha");
      await screen.findByText(
        "Invalid authentication link. Missing session ID.",
      );
      expect(screen.queryByTestId("location")).toBeNull();
      expect(state.complete).not.toHaveBeenCalled();
    },
  );
});
