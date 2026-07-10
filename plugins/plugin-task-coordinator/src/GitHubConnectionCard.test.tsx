// @vitest-environment jsdom
//
// The GitHub connection card is the guided credential setup step (#15796):
// PAT paste plus — when the agent has a GITHUB_OAUTH_CLIENT_ID — a device
// sign-in path (start → show user code → poll → connected). These tests pin
// the card's wiring against the plugin-github route contract: what it sends,
// how it renders each protocol outcome (pending/complete/denied/expired), and
// that cancelling really stops the poll loop.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const openExternalUrlMock = vi.fn();

vi.mock("@elizaos/ui", () => ({
  client: {
    fetch: (path: string, init?: RequestInit) => fetchMock(path, init),
  },
  openExternalUrl: (url: string) => openExternalUrlMock(url),
  Button: ({
    children,
    unstyled: _unstyled,
    variant: _variant,
    size: _size,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    unstyled?: boolean;
    variant?: string;
    size?: string;
  }) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
  SettingsControls: {
    Input: ({
      variant: _variant,
      ...rest
    }: React.InputHTMLAttributes<HTMLInputElement> & { variant?: string }) => (
      <input {...rest} />
    ),
  },
}));

import { GitHubConnectionCard } from "./GitHubConnectionCard";

interface RouteScript {
  status?: unknown;
  deviceStart?: () => unknown;
  devicePoll?: () => unknown;
  tokenPost?: () => unknown;
}

function scriptRoutes(script: RouteScript) {
  fetchMock.mockImplementation((path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/github/token" && method === "GET") {
      return Promise.resolve(
        script.status ?? { connected: false, deviceFlowAvailable: false },
      );
    }
    if (path === "/api/github/device/start" && method === "POST") {
      if (!script.deviceStart) throw new Error("unexpected device start");
      return Promise.resolve(script.deviceStart());
    }
    if (path === "/api/github/device/poll" && method === "POST") {
      if (!script.devicePoll) throw new Error("unexpected device poll");
      return Promise.resolve(script.devicePoll());
    }
    if (path === "/api/github/token" && method === "POST") {
      if (!script.tokenPost) throw new Error("unexpected token post");
      return Promise.resolve(script.tokenPost());
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  });
}

function startedFlow(overrides?: Partial<Record<string, unknown>>) {
  return {
    status: "started",
    flowId: "flow-1",
    userCode: "ABCD-EFGH",
    verificationUri: "https://github.com/login/device",
    intervalSeconds: 1,
    expiresInSeconds: 900,
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  openExternalUrlMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GitHubConnectionCard", () => {
  it("offers only the PAT path when the agent has no device-flow client id", async () => {
    scriptRoutes({ status: { connected: false, deviceFlowAvailable: false } });
    render(<GitHubConnectionCard />);
    await waitFor(() =>
      expect(screen.getByText(/Generate a token on github.com/)).toBeTruthy(),
    );
    expect(screen.queryByText("Sign in with GitHub")).toBeNull();
  });

  it("runs the guided sign-in: shows the user code, opens GitHub, polls to connected", async () => {
    let polls = 0;
    scriptRoutes({
      status: { connected: false, deviceFlowAvailable: true },
      deviceStart: () => startedFlow(),
      devicePoll: () => {
        polls += 1;
        return polls === 1
          ? { status: "pending", retryAfterSeconds: 1 }
          : {
              status: "complete",
              connected: true,
              deviceFlowAvailable: true,
              username: "octocat",
              scopes: ["repo", "read:user"],
            };
      },
    });
    render(<GitHubConnectionCard />);

    const signIn = await screen.findByText("Sign in with GitHub");
    fireEvent.click(signIn);

    // The short code renders and GitHub's verification page opens.
    expect(await screen.findByTestId("github-device-user-code")).toBeTruthy();
    expect(screen.getByTestId("github-device-user-code").textContent).toBe(
      "ABCD-EFGH",
    );
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://github.com/login/device",
    );

    // Pending → complete over the server-provided cadence.
    await waitFor(() => expect(screen.getByText("@octocat")).toBeTruthy(), {
      timeout: 5_000,
    });
    expect(polls).toBe(2);
    // The poll body carried the opaque flow id.
    const pollCall = fetchMock.mock.calls.find(
      ([path]) => path === "/api/github/device/poll",
    );
    expect(JSON.parse(String(pollCall?.[1]?.body))).toEqual({
      flowId: "flow-1",
    });
  }, 15_000);

  it("surfaces a denied grant as an actionable error and returns to the sign-in button", async () => {
    scriptRoutes({
      status: { connected: false, deviceFlowAvailable: true },
      deviceStart: () => startedFlow(),
      devicePoll: () => ({ status: "denied" }),
    });
    render(<GitHubConnectionCard />);

    fireEvent.click(await screen.findByText("Sign in with GitHub"));
    await waitFor(
      () => expect(screen.getByText(/sign-in was denied/)).toBeTruthy(),
      { timeout: 5_000 },
    );
    // The card recovers: the guided button is available again.
    expect(screen.getByText("Sign in with GitHub")).toBeTruthy();
  }, 15_000);

  it("surfaces an expired code as an actionable error", async () => {
    scriptRoutes({
      status: { connected: false, deviceFlowAvailable: true },
      deviceStart: () => startedFlow(),
      devicePoll: () => ({ status: "expired" }),
    });
    render(<GitHubConnectionCard />);

    fireEvent.click(await screen.findByText("Sign in with GitHub"));
    await waitFor(() => expect(screen.getByText(/code expired/)).toBeTruthy(), {
      timeout: 5_000,
    });
  }, 15_000);

  it("shows the server's owner-setup message when starting the flow fails", async () => {
    scriptRoutes({
      status: { connected: false, deviceFlowAvailable: true },
      deviceStart: () => {
        throw new Error(
          "GitHub device sign-in needs owner setup: no GITHUB_OAUTH_CLIENT_ID setting is configured",
        );
      },
    });
    // client.fetch throws ApiError (an Error) for non-2xx responses.
    fetchMock.mockImplementation((path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (path === "/api/github/token" && method === "GET") {
        return Promise.resolve({ connected: false, deviceFlowAvailable: true });
      }
      if (path === "/api/github/device/start") {
        return Promise.reject(
          new Error(
            "GitHub device sign-in needs owner setup: no GITHUB_OAUTH_CLIENT_ID setting is configured",
          ),
        );
      }
      throw new Error(`unexpected request: ${method} ${path}`);
    });
    render(<GitHubConnectionCard />);

    fireEvent.click(await screen.findByText("Sign in with GitHub"));
    await waitFor(() =>
      expect(screen.getByText(/needs owner setup/)).toBeTruthy(),
    );
  });

  it("cancelling the sign-in stops the poll loop", async () => {
    scriptRoutes({
      status: { connected: false, deviceFlowAvailable: true },
      deviceStart: () => startedFlow({ intervalSeconds: 1 }),
      devicePoll: () => ({ status: "pending", retryAfterSeconds: 1 }),
    });
    render(<GitHubConnectionCard />);

    fireEvent.click(await screen.findByText("Sign in with GitHub"));
    expect(await screen.findByTestId("github-device-user-code")).toBeTruthy();

    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByTestId("github-device-user-code")).toBeNull();

    const pollsAtCancel = fetchMock.mock.calls.filter(
      ([path]) => path === "/api/github/device/poll",
    ).length;
    // Give any (buggy) surviving timer a chance to fire, then re-count.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const pollsAfterWait = fetchMock.mock.calls.filter(
      ([path]) => path === "/api/github/device/poll",
    ).length;
    expect(pollsAfterWait).toBe(pollsAtCancel);
  }, 15_000);

  it("keeps the PAT paste path working (connect posts the token)", async () => {
    scriptRoutes({
      status: { connected: false, deviceFlowAvailable: true },
      tokenPost: () => ({
        connected: true,
        deviceFlowAvailable: true,
        username: "octocat",
        scopes: ["repo"],
      }),
    });
    render(<GitHubConnectionCard />);

    const input = (await screen.findByPlaceholderText(
      "ghp_…",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ghp_pasted" } });
    fireEvent.click(screen.getByText("Connect"));

    await waitFor(() => expect(screen.getByText("@octocat")).toBeTruthy());
    const postCall = fetchMock.mock.calls.find(
      ([path, init]) => path === "/api/github/token" && init?.method === "POST",
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      token: "ghp_pasted",
    });
  });
});
