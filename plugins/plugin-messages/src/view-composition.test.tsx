// @vitest-environment jsdom

/**
 * Verifies the Messages host-view ABI with real module entry paths and a
 * deterministic render seam. Signed, `/ui`, and dynamic entry points must mount
 * the same framed page while the underlying conversation view stays interactive.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const registration = vi.hoisted(() => ({ register: vi.fn() }));

vi.mock("@elizaos/ui/app-shell-registry", () => ({
  registerAppShellPage: registration.register,
}));
vi.mock("@elizaos/ui/platform/init", () => ({ isElizaOS: () => true }));
vi.mock("@elizaos/ui/components", () => ({
  PluginPageFrame: ({
    children,
    title,
  }: React.PropsWithChildren<{ title: string }>) => (
    <main aria-label={`${title} page`}>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));
vi.mock("./components/MessagesView.tsx", () => ({
  MessagesView: () => {
    const [opened, setOpened] = useState(false);
    return (
      <button type="button" onClick={() => setOpened(true)}>
        {opened ? "Conversation opened" : "Open conversation"}
      </button>
    );
  },
}));

afterEach(() => {
  cleanup();
  registration.register.mockClear();
  vi.resetModules();
});

async function exercise(component: React.ComponentType): Promise<string> {
  render(React.createElement(component));
  expect(screen.getByRole("main", { name: "Messages page" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
  return (
    screen.getByRole("button", { name: "Conversation opened" }).textContent ??
    ""
  );
}

describe("Messages framed-view ABI", () => {
  it("keeps signed, /ui, and dynamic loaders compositionally equivalent", async () => {
    await import("./register.ts");
    const registrationCall = registration.register.mock.calls[0]?.[0];
    expect(registrationCall).toBeDefined();

    const [signed, ui, dynamic, raw] = await Promise.all([
      registrationCall.loader(),
      import("./ui.ts"),
      import("./components/messages-view-bundle.ts"),
      import("./components/MessagesView.tsx"),
    ]);

    expect(signed.default).toBe(ui.MessagesView);
    expect(dynamic.MessagesView).toBe(ui.MessagesView);
    expect(dynamic.MessagesView).not.toBe(raw.MessagesView);
    const signedOutcome = await exercise(signed.default);
    cleanup();
    const dynamicOutcome = await exercise(dynamic.MessagesView);
    expect(dynamicOutcome).toBe(signedOutcome);
  });
});
