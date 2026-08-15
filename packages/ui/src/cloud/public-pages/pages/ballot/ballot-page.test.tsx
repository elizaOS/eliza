/** Verifies BallotPage loading and error landmarks for #18071. */
// @vitest-environment jsdom

/**
 * Public ballot error/loading states must expose a main landmark, a heading,
 * an accessible loading name, and a keyboard-reachable recovery link. The
 * router and api-client are doubled; the page is real.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paramsRef = vi.hoisted(() => ({
  current: { ballotId: "qa-invalid" as string | undefined },
}));
const searchParamsRef = vi.hoisted(() => new URLSearchParams(""));
const apiMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({
  useParams: () => paramsRef.current,
  useSearchParams: () => [searchParamsRef, vi.fn()],
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

vi.mock("../../../../components/ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

vi.mock("../../../../components/ui/textarea", () => ({
  Textarea: (props: Record<string, unknown>) => <textarea {...props} />,
}));

import { ApiError } from "../../../lib/api-client";
import BallotPage from "./ballot-page";

describe("BallotPage public error and loading a11y (#18071)", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    apiMock.mockReset();
    paramsRef.current = { ballotId: "qa-invalid" };
  });

  it("exposes an accessible loading status before the fetch settles", () => {
    apiMock.mockImplementation(() => new Promise(() => {}));

    render(<BallotPage />);

    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Loading ballot…")).toBeTruthy();
  });

  it("renders main, heading, and recovery link for a malformed ballot id", async () => {
    apiMock.mockRejectedValue(
      new ApiError(400, "validation_error", "Invalid ballot id"),
    );

    render(<BallotPage />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          level: 1,
          name: "Ballot unavailable",
        }),
      ).toBeTruthy();
    });

    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByText("Invalid ballot id")).toBeTruthy();
    const recovery = screen.getByRole("link", {
      name: "Return to Eliza Cloud",
    });
    expect(recovery.getAttribute("href")).toBe("/");
  });

  it("keeps the same landmarks when a well-formed id is missing", async () => {
    paramsRef.current = {
      ballotId: "00000000-0000-4000-8000-000000000099",
    };
    apiMock.mockRejectedValue(
      new ApiError(404, "not_found", "Ballot not found"),
    );

    render(<BallotPage />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          level: 1,
          name: "Ballot unavailable",
        }),
      ).toBeTruthy();
    });

    expect(screen.getByRole("main")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Return to Eliza Cloud" }),
    ).toBeTruthy();
  });
});
