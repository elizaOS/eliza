/** Verifies the canonical authentication result shell's page semantics. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthResultShell } from "./auth-result-shell";

afterEach(cleanup);

describe("AuthResultShell", () => {
  it("renders result content inside the full-page main landmark", () => {
    render(
      <AuthResultShell>
        <h1>Authentication complete</h1>
      </AuthResultShell>,
    );

    const heading = screen.getByRole("heading", {
      name: "Authentication complete",
    });
    const main = screen.getByRole("main");
    expect(main.contains(heading)).toBe(true);
    expect(main.className).toContain("min-h-[100dvh]");
  });
});
