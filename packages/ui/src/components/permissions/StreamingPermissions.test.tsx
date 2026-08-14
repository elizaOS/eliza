/**
 * Drives StreamingPermissionsSettingsView after permissions check settles.
 * jsdom; media APIs are absent so rows render as Not Set + Grant.
 */
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../state", () => ({
  useAppSelector: (
    selector: (s: {
      t: (key: string, options?: { defaultValue?: string }) => string;
    }) => unknown,
  ) =>
    selector({
      t: (_key, options) => options?.defaultValue ?? _key,
    }),
}));

import { StreamingPermissionsSettingsView } from "./StreamingPermissions";

afterEach(cleanup);

describe("StreamingPermissionsSettingsView", () => {
  it("renders camera, microphone, and screen as SettingsRows with Grant", async () => {
    render(
      <StreamingPermissionsSettingsView
        mode="web"
        testId="streaming-permissions"
        title="Streaming permissions"
      />,
    );
    expect(await screen.findByText("Streaming permissions")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("Camera")).toBeTruthy();
    });
    expect(screen.getByText("Microphone")).toBeTruthy();
    expect(screen.getByText("Screen")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Grant / }).length).toBe(3);
  });
});
