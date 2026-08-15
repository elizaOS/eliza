/**
 * Deterministic route test for the retired Cloud Applications handoff. It
 * proves replacement navigation stays inside the shell-authority channel.
 */
// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { runAsPrivilegedShell } from "../../surface-realm-channel";
import AppsMovedRoute from "./AppsMovedRoute";

vi.mock("../../surface-realm-channel", () => ({
  runAsPrivilegedShell: vi.fn((operation: () => unknown) => operation()),
}));

describe("AppsMovedRoute", () => {
  it("replaces the retired route through shell navigation authority", async () => {
    render(
      <MemoryRouter initialEntries={["/cloud/apps"]}>
        <Routes>
          <Route path="/cloud/apps" element={<AppsMovedRoute />} />
          <Route path="/cloud" element={<div>Cloud dashboard</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Cloud dashboard")).toBeTruthy();
    expect(runAsPrivilegedShell).toHaveBeenCalledTimes(1);
  });
});
