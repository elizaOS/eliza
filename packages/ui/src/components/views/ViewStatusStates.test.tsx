/** Verifies that shared dynamic-view status surfaces provide actionable recovery copy. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ViewUnavailableState } from "./ViewStatusStates";

afterEach(cleanup);

describe("ViewUnavailableState", () => {
  it("explains how to recover an unavailable app view", () => {
    render(<ViewUnavailableState viewId="camera" />);

    expect(
      screen.getByText(
        "This app is unavailable here. Install or enable it, then try again.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("App: camera")).toBeTruthy();
  });
});
