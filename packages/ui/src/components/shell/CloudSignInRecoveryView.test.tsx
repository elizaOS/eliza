/** Verifies that failed Cloud authentication remains a recoverable sign-in gate. */
// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CloudSignInRecoveryView } from "./CloudSignInRecoveryView";

vi.mock("../../state", () => ({
  useAppSelector: <T,>(
    selector: (state: {
      t: (key: string, options?: { defaultValue?: string }) => string;
    }) => T,
  ): T =>
    selector({
      t: (_key, options) => options?.defaultValue ?? _key,
    }),
}));

describe("CloudSignInRecoveryView", () => {
  it("names the sign-in failure and retries without exposing startup recovery", () => {
    const onRetry = vi.fn();
    render(
      <CloudSignInRecoveryView
        detail="Eliza Cloud sign-in was cancelled."
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("heading").textContent).toBe(
      "Sign in to Eliza Cloud",
    );
    expect(screen.getByRole("status").textContent).toContain("cancelled");
    expect(screen.queryByText("Something went wrong")).toBeNull();

    fireEvent.click(screen.getByTestId("cloud-sign-in-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
