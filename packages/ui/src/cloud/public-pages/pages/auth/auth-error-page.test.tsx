/** Recovery semantics for the public authentication-error route. */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { appModeNavigation } from "../../../app-mode/app-mode";

const navigateMock = vi.hoisted(() => vi.fn());
const replaceMock = vi.hoisted(() => vi.fn());
const searchParamsRef = vi.hoisted(() => ({
  current: new URLSearchParams(
    "reason=sync_failed&returnTo=%2Fchat%3Fthread%3Done",
  ),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

import AuthErrorPage, { AuthErrorPageForHost } from "./auth-error-page";

const realReplace = appModeNavigation.replace;

beforeEach(() => {
  navigateMock.mockReset();
  replaceMock.mockReset();
  appModeNavigation.replace = replaceMock;
  searchParamsRef.current = new URLSearchParams(
    "reason=sync_failed&returnTo=%2Fchat%3Fthread%3Done",
  );
});

afterEach(cleanup);
afterAll(() => {
  appModeNavigation.replace = realReplace;
});

describe("AuthErrorPage", () => {
  it("announces the recovery surface by focusing its page heading", async () => {
    render(<AuthErrorPage />);

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Authentication Sync Failed",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });

  it("preserves the sanitized deep-link when the user retries", () => {
    render(<AuthErrorPage />);

    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(navigateMock).toHaveBeenCalledWith(
      "/login?returnTo=%2Fchat%3Fthread%3Done",
    );
  });

  it("restarts mint-host recovery on the paired app login", () => {
    render(<AuthErrorPageForHost hostname="staging.eliza.app" />);

    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(replaceMock).toHaveBeenCalledWith(
      "https://cloud-staging.eliza.app/login?returnTo=%2Fchat%3Fthread%3Done",
    );
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin retry target and falls back to join", () => {
    searchParamsRef.current = new URLSearchParams(
      "reason=auth_failed&returnTo=https%3A%2F%2Fevil.example%2Fsteal",
    );
    render(<AuthErrorPage />);

    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(navigateMock).toHaveBeenCalledWith("/login?returnTo=%2Fjoin");
  });

  it("keeps visible keyboard-focus styling on both recovery actions", () => {
    render(<AuthErrorPage />);

    expect(
      screen.getByRole("button", { name: "Try Again" }).className,
    ).toContain("hosted-signin-focus-emphasis");
    expect(screen.getByRole("link", { name: "Go Home" }).className).toContain(
      "hosted-signin-focus-emphasis",
    );
  });
});
