// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authRef = vi.hoisted(() => ({
  current: {
    isLoading: false,
    isAuthenticated: true,
    getToken: vi.fn(() => "token-1"),
    signOut: vi.fn(),
    providers: [],
    isProvidersLoading: false,
  },
}));

const pushMock = vi.hoisted(() => vi.fn());
const searchParamsRef = vi.hoisted(() => ({
  current: new URLSearchParams(
    "app_id=app-1&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&state=state-1",
  ),
}));

vi.mock("@stwd/react", () => ({
  StewardLogin: ({ title }: { title?: string }) => (
    <div data-testid="steward-login">{title}</div>
  ),
  useAuth: () => authRef.current,
}));

vi.mock("../../runtime/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => searchParamsRef.current,
}));

vi.mock("../../runtime/image", () => ({
  default: (props: { src: string; alt: string }) => (
    <img src={props.src} alt={props.alt} />
  ),
}));

import { AuthorizeContent } from "./authorize-content";

function mockAppFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        app: {
          id: "app-1",
          name: "Demo App",
          website_url: "https://demo.example",
        },
      }),
    })),
  );
}

describe("AuthorizeContent", () => {
  const realLocation = window.location;
  let locationAssignMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    locationAssignMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...realLocation, assign: locationAssignMock },
    });
    authRef.current = {
      isLoading: false,
      isAuthenticated: true,
      getToken: vi.fn(() => "token-1"),
      signOut: vi.fn(),
      providers: [],
      isProvidersLoading: false,
    };
    pushMock.mockReset();
    searchParamsRef.current = new URLSearchParams(
      "app_id=app-1&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&state=state-1",
    );
    mockAppFetch();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
  });

  it("renders a compact signed-in consent screen with one primary action and one cancel affordance", async () => {
    render(<AuthorizeContent />);

    await waitFor(() => expect(screen.getByText("Demo App")).toBeTruthy());

    expect(
      screen.getByText(
        "Connect Demo App to your Eliza Cloud account. AI features may use your cloud credit balance.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("This app wants to:")).toBeNull();
    expect(screen.queryByText("Access your Eliza Cloud account")).toBeNull();
    expect(screen.queryByText(/By continuing/)).toBeNull();
    expect(screen.queryByText("Signed in")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Authorize Demo App" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("sends signed-in users through the cancel redirect", async () => {
    const user = userEvent.setup();

    render(<AuthorizeContent />);

    await waitFor(() => expect(screen.getByText("Demo App")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(locationAssignMock).toHaveBeenCalledWith(
      "https://example.com/callback?error=access_denied&error_description=User+denied+authorization&state=state-1",
    );
  });

  it("keeps the signed-out state to sign-in controls plus one cancel affordance", async () => {
    authRef.current = {
      ...authRef.current,
      isAuthenticated: false,
    };

    render(<AuthorizeContent />);

    await waitFor(() => expect(screen.getByText("Demo App")).toBeTruthy());

    expect(screen.getByTestId("steward-login").textContent).toBe(
      "Sign in to authorize",
    );
    expect(screen.queryByText("This app wants to:")).toBeNull();
    expect(screen.queryByText(/By continuing/)).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("sends signed-out users through the cancel redirect", async () => {
    const user = userEvent.setup();
    authRef.current = {
      ...authRef.current,
      isAuthenticated: false,
    };

    render(<AuthorizeContent />);

    await waitFor(() => expect(screen.getByText("Demo App")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(locationAssignMock).toHaveBeenCalledWith(
      "https://example.com/callback?error=access_denied&error_description=User+denied+authorization&state=state-1",
    );
  });
});
