/**
 * Drives the Cloud Applications settings entry: the shipped nav row opens
 * /cloud/apps. jsdom; i18n and the settings shell are mocked.
 */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

import { ApplicationsEntry } from "./applications-entry";

afterEach(cleanup);

describe("ApplicationsEntry", () => {
  it("assigns /cloud/apps when the settings row is activated", async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, assign },
    });

    render(<ApplicationsEntry />);
    await user.click(screen.getByText("Manage applications"));
    expect(assign).toHaveBeenCalledWith("/cloud/apps");

    Object.defineProperty(window, "location", {
      configurable: true,
      value: original,
    });
  });
});
