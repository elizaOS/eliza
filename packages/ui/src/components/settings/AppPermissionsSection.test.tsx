/** Keeps the empty app-sandbox state distinct from macOS capability permissions. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({ setActionNotice: vi.fn() }));
const clientMock = vi.hoisted(() => ({
  listAppPermissions: vi.fn(),
  setAppPermissions: vi.fn(),
}));

vi.mock("../../state", () => ({
  useAppSelector: (selector: (state: typeof appMock) => unknown) =>
    selector(appMock),
}));
vi.mock("../../api/client", () => ({ client: clientMock }));

import { AppPermissionsSection } from "./AppPermissionsSection";

describe("AppPermissionsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.listAppPermissions.mockResolvedValue([]);
  });

  afterEach(cleanup);

  it("explains that an empty list is app sandbox access, not OS permissions", async () => {
    render(<AppPermissionsSection />);

    expect(
      await screen.findByText(
        "No installed apps request filesystem or network access.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("No apps declare permissions yet."),
    ).toBeNull();
  });
});
