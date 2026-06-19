import "@testing-library/jest-dom/vitest";
import { STEWARD_TOKEN_KEY } from "@elizaos/shared/steward-session-client";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useSessionAuth } from "./use-session-auth";

function tokenFor(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode(payload),
    "signature",
  ].join(".");
}

function AuthProbe() {
  const session = useSessionAuth();
  return (
    <div>
      <div data-testid="authenticated">{String(session.authenticated)}</div>
      <div data-testid="auth-source">{session.authSource}</div>
      <div data-testid="user-id">{session.user?.id ?? ""}</div>
    </div>
  );
}

beforeEach(() => {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom auth-cookie setup.
  document.cookie = "steward-authed=; Max-Age=0; Path=/";
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("useSessionAuth", () => {
  test("accepts a valid Steward token when the marker cookie is not visible", () => {
    const token = tokenFor({
      userId: "user_123",
      email: "user@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    window.localStorage.setItem(STEWARD_TOKEN_KEY, token);

    render(<AuthProbe />);

    expect(screen.getByTestId("authenticated")).toHaveTextContent("true");
    expect(screen.getByTestId("auth-source")).toHaveTextContent("steward");
    expect(screen.getByTestId("user-id")).toHaveTextContent("user_123");
  });

  test("rejects an expired Steward token", () => {
    const token = tokenFor({
      userId: "user_123",
      email: "user@example.com",
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    window.localStorage.setItem(STEWARD_TOKEN_KEY, token);

    render(<AuthProbe />);

    expect(screen.getByTestId("authenticated")).toHaveTextContent("false");
    expect(screen.getByTestId("auth-source")).toHaveTextContent("none");
    expect(screen.getByTestId("user-id")).toHaveTextContent("");
  });
});
