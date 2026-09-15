/** Verifies retired Security links replace-navigate to Account under shell authority. */
// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import SecurityMovedRoute from "./SecurityMovedRoute";

describe("SecurityMovedRoute", () => {
  it("sends stale bookmarks to Account without exposing a Security page", async () => {
    render(
      <MemoryRouter initialEntries={["/cloud/security"]}>
        <Routes>
          <Route path="/cloud/security" element={<SecurityMovedRoute />} />
          <Route path="/cloud/account" element={<div>Account page</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Account page")).toBeTruthy();
  });
});
