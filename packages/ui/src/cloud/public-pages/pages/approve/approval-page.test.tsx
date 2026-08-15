/** Verifies ApprovalPage loading and error landmarks for #18074. */
// @vitest-environment jsdom

/**
 * Public approval error/loading states must expose a main landmark, a heading,
 * an accessible loading name, and a keyboard-reachable recovery link. The
 * router and api-client are doubled; the page is real.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paramsRef = vi.hoisted(() => ({
  current: { approvalId: "qa-invalid" as string | undefined },
}));
const apiMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({
  useParams: () => paramsRef.current,
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT:
    () =>
    (
      _key: string,
      opts?: { defaultValue?: string } & Record<string, string | number>,
    ) => {
      let value = opts?.defaultValue ?? _key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          if (k === "defaultValue") continue;
          value = value.replace(`{{${k}}}`, String(v));
        }
      }
      return value;
    },
}));

vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

vi.mock("../../../lib/api-client", () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "ApiError";
    }
  }
  return { api: apiMock, ApiError };
});

vi.mock("../../../../components/ui/button", () => ({
  Button: ({
    children,
    ...rest
  }: {
    children: ReactNode;
  } & Record<string, unknown>) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("../../../../components/ui/textarea", () => ({
  Textarea: (props: Record<string, unknown>) => <textarea {...props} />,
}));

import { ApiError } from "../../../lib/api-client";
import ApprovalPage from "./approval-page";

describe("ApprovalPage public error and loading a11y (#18074)", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    apiMock.mockReset();
    paramsRef.current = { approvalId: "qa-invalid" };
  });

  it("exposes an accessible loading status before the fetch settles", () => {
    apiMock.mockImplementation(() => new Promise(() => {}));

    render(<ApprovalPage />);

    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Loading approval request…")).toBeTruthy();
  });

  it("renders main, heading, and recovery link for a load failure", async () => {
    apiMock.mockRejectedValue(
      new ApiError(500, "internal_error", "An unexpected error occurred"),
    );

    render(<ApprovalPage />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
        "Could not load approval request",
      );
    });

    expect(screen.getByRole("main")).toBeTruthy();
    const recovery = screen.getByRole("link", {
      name: "Return to Eliza Cloud",
    });
    expect(recovery.getAttribute("href")).toBe("/");
  });
});
