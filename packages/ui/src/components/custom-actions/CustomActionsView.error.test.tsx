// @vitest-environment jsdom

/**
 * Three-state coverage for full-page custom action loading and row mutations.
 *
 * Transport failures render an explicit retry state, a runtime-level 404 stays
 * the designed empty state, and per-row write failures surface an alert while
 * keeping the server-confirmed row state visible.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client-types-core";

const clientMock = vi.hoisted(() => ({
  listCustomActions: vi.fn(),
  createCustomAction: vi.fn(),
  updateCustomAction: vi.fn(),
  deleteCustomAction: vi.fn(),
}));

vi.mock("../../api/client", () => ({ client: clientMock }));

vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (s: {
      t: (
        key: string,
        options?: { defaultValue?: string; [key: string]: unknown },
      ) => string;
    }) => unknown,
  ) =>
    selector({
      t: (key, options) => options?.defaultValue ?? key,
    }),
}));

const confirmDesktopActionMock = vi.hoisted(() => vi.fn());
vi.mock("../../utils/desktop-dialogs", () => ({
  confirmDesktopAction: confirmDesktopActionMock,
  alertDesktopMessage: vi.fn(),
}));

vi.mock("./CustomActionEditor", () => ({
  CustomActionEditor: () => null,
}));

import { CustomActionsView } from "./CustomActionsView";

const sampleAction = {
  id: "action-1",
  name: "Ping service",
  description: "Pings the service",
  enabled: true,
  handler: { type: "http" },
  parameters: [],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clientMock.listCustomActions.mockReset();
  clientMock.updateCustomAction.mockReset();
  clientMock.deleteCustomAction.mockReset();
  confirmDesktopActionMock.mockReset();
});

describe("CustomActionsView three-state rendering", () => {
  it("renders the error state (not the designed empty state) when the load 500s", async () => {
    clientMock.listCustomActions.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/custom-actions",
        message: "Internal Server Error",
        status: 500,
      }),
    );

    render(<CustomActionsView />);

    await waitFor(() =>
      expect(screen.getByTestId("custom-actions-load-error")).not.toBeNull(),
    );
    expect(
      screen.getByTestId("custom-actions-load-error").textContent,
    ).toContain("Couldn't load custom actions.");
    expect(screen.queryByText("customactionsview.EmptyTitle")).toBeNull();
  });

  it("renders the error state on a transport failure", async () => {
    clientMock.listCustomActions.mockRejectedValue(
      new TypeError("Failed to fetch"),
    );

    render(<CustomActionsView />);

    await waitFor(() =>
      expect(screen.getByTestId("custom-actions-load-error")).not.toBeNull(),
    );
    expect(screen.queryByText("customactionsview.EmptyTitle")).toBeNull();
  });

  it("recovers to the list when retry succeeds", async () => {
    clientMock.listCustomActions
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce([sampleAction]);

    render(<CustomActionsView />);

    await waitFor(() =>
      expect(screen.getByTestId("custom-actions-load-error")).not.toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() =>
      expect(screen.getByText("Ping service")).not.toBeNull(),
    );
    expect(screen.queryByTestId("custom-actions-load-error")).toBeNull();
  });

  it("renders the designed empty state (not an error) when the surface 404s", async () => {
    clientMock.listCustomActions.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/custom-actions",
        message: "Not Found",
        status: 404,
      }),
    );

    render(<CustomActionsView />);

    await waitFor(() =>
      expect(screen.getByText("customactionsview.EmptyTitle")).not.toBeNull(),
    );
    expect(screen.queryByTestId("custom-actions-load-error")).toBeNull();
  });

  it("surfaces a visible error when the enable toggle fails", async () => {
    clientMock.listCustomActions.mockResolvedValue([sampleAction]);
    clientMock.updateCustomAction.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/custom-actions/action-1",
        message: "Internal Server Error",
        status: 500,
      }),
    );

    render(<CustomActionsView />);

    await waitFor(() =>
      expect(screen.getByText("Ping service")).not.toBeNull(),
    );

    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() =>
      expect(screen.getByTestId("custom-actions-action-error")).not.toBeNull(),
    );
    expect(
      screen.getByTestId("custom-actions-action-error").textContent,
    ).toContain("Couldn't update this action.");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("surfaces a visible error when delete fails and keeps the item listed", async () => {
    clientMock.listCustomActions.mockResolvedValue([sampleAction]);
    confirmDesktopActionMock.mockResolvedValue(true);
    clientMock.deleteCustomAction.mockRejectedValue(
      new ApiError({
        kind: "http",
        path: "/api/custom-actions/action-1",
        message: "Internal Server Error",
        status: 500,
      }),
    );

    render(<CustomActionsView />);

    await waitFor(() =>
      expect(screen.getByText("Ping service")).not.toBeNull(),
    );

    fireEvent.click(screen.getByRole("button", { name: "common.delete" }));

    await waitFor(() =>
      expect(screen.getByTestId("custom-actions-action-error")).not.toBeNull(),
    );
    expect(
      screen.getByTestId("custom-actions-action-error").textContent,
    ).toContain("Couldn't delete this action.");
    expect(screen.getByText("Ping service")).not.toBeNull();
  });
});
