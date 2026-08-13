/** Verifies the registered setup boundary bypasses Steward and all network until explicit consent. */
// @vitest-environment jsdom

import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CloudRouterShell } from "../shell/CloudRouterShell";
import {
  CLOUD_PUBLIC_ROUTE_ACCESS,
  getCloudRoute,
} from "../shell/cloud-route-registry";
import {
  GET_STARTED_ROUTE_PATH,
  JOIN_ROUTE_PATH,
  registerJoinFlow,
} from "./register";

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function liveStewardToken(): string {
  return [
    base64url({ alg: "none", typ: "JWT" }),
    base64url({
      userId: "route-boundary-user",
      email: "route-boundary@example.test",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    "sig",
  ].join(".");
}

beforeAll(() => {
  registerJoinFlow();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("registered /get-started boundary", () => {
  it("is the only reviewed public join-domain route", () => {
    expect(getCloudRoute(GET_STARTED_ROUTE_PATH)).toMatchObject({
      group: "auth",
      public: true,
      publicAccess: CLOUD_PUBLIC_ROUTE_ACCESS,
    });
    expect(getCloudRoute(JOIN_ROUTE_PATH)?.public).not.toBe(true);
  });

  it.each(["signed-out", "signed-in"])(
    "performs zero network for a %s visitor through the real route shell",
    async (sessionState) => {
      const token = liveStewardToken();
      if (sessionState === "signed-in") {
        window.localStorage.setItem(STEWARD_TOKEN_KEY, token);
      }
      window.history.replaceState(null, "", "/get-started");
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 204 }));

      render(
        <CloudRouterShell
          appElement={<div data-testid="agent-app">agent app</div>}
        />,
      );

      expect(
        await screen.findByRole("heading", { name: "Set up Eliza Cloud" }),
      ).toBeTruthy();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(screen.queryByTestId("agent-app")).toBeNull();
      expect(window.localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(
        sessionState === "signed-in" ? token : null,
      );
    },
  );
});
