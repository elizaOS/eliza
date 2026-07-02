// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enabledProviders = vi.hoisted(() => ({
  passkey: true,
  email: true,
  siwe: false,
  siws: false,
  google: true,
  discord: true,
  github: false,
  twitter: false,
  oauth: ["google", "discord"],
}));

const authRef = vi.hoisted(() => ({
  current: {
    isLoading: false,
    isAuthenticated: true,
    getToken: vi.fn(() => "token-1"),
    signOut: vi.fn(),
    providers: enabledProviders,
    isProvidersLoading: false,
    signInWithOAuth: vi.fn(),
    activeTenantId: "elizacloud",
  },
}));

const useAuthMock = vi.hoisted(() => vi.fn(() => authRef.current));
const pushMock = vi.hoisted(() => vi.fn());
const searchParamsRef = vi.hoisted(() => ({
  current: new URLSearchParams(
    "app_id=app-1&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&state=state-1",
  ),
}));

vi.mock("@stwd/react", () => ({
  DiscordIcon: ({ size }: { size?: number }) => (
    <svg aria-hidden="true" data-size={size} data-testid="discord-icon" />
  ),
  GoogleIcon: ({ size }: { size?: number }) => (
    <svg aria-hidden="true" data-size={size} data-testid="google-icon" />
  ),
  StewardLogin: ({
    showDiscord,
    showGoogle,
    title,
  }: {
    showDiscord?: boolean;
    showGoogle?: boolean;
    title?: string;
  }) => (
    <div
      data-show-discord={String(showDiscord)}
      data-show-google={String(showGoogle)}
      data-testid="steward-login"
    >
      {title}
    </div>
  ),
  useAuth: () => useAuthMock(),
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
      providers: enabledProviders,
      isProvidersLoading: false,
      signInWithOAuth: vi.fn(),
      activeTenantId: "elizacloud",
    };
    useAuthMock.mockClear();
    pushMock.mockReset();
    searchParamsRef.current = new URLSearchParams(
      "app_id=app-1&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&state=state-1",
    );
    mockAppFetch();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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

  it("uses the local Playwright test-auth adapter without calling the Steward hook", async () => {
    vi.stubEnv("VITE_PLAYWRIGHT_TEST_AUTH", "true");

    render(<AuthorizeContent />);

    await waitFor(() => expect(screen.getByText("Demo App")).toBeTruthy());

    expect(useAuthMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Authorize Demo App" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("steward-login")).toBeNull();
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
    expect(
      screen.getByTestId("steward-login").getAttribute("data-show-google"),
    ).toBe("false");
    expect(
      screen.getByTestId("steward-login").getAttribute("data-show-discord"),
    ).toBe("false");
    expect(
      screen.getByRole("button", { name: "Continue with Google" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Continue with Discord" }),
    ).toBeTruthy();
    expect(screen.queryByText("This app wants to:")).toBeNull();
    expect(screen.queryByText(/By continuing/)).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("starts app-auth OAuth with the allowlisted Steward login redirect", async () => {
    const user = userEvent.setup();
    const signInWithOAuth = vi.fn(async () => ({
      token: "token-1",
      user: { id: "user-1", email: "nubs@example.com" },
    }));
    authRef.current = {
      ...authRef.current,
      isAuthenticated: false,
      signInWithOAuth,
    };

    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...realLocation,
        assign: locationAssignMock,
        origin: "https://elizacloud.ai",
      },
    });

    render(<AuthorizeContent />);

    await waitFor(() => expect(screen.getByText("Demo App")).toBeTruthy());
    await user.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );

    await waitFor(() =>
      expect(signInWithOAuth).toHaveBeenCalledWith("google", {
        redirectUri: "https://elizacloud.ai/login",
        tenantId: "elizacloud",
      }),
    );
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
