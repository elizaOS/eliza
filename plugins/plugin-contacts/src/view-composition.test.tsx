// @vitest-environment jsdom

/**
 * Verifies the Contacts host-view ABI with real module entry paths and a
 * deterministic render seam. Signed, `/ui`, and dynamic entry points must mount
 * the same framed page while the underlying address-book view stays interactive.
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
vi.mock("./components/contacts-app.ts", () => ({
  registerContactsApp: vi.fn(),
}));
vi.mock("./components/ContactsView.tsx", () => ({
  ContactsView: () => {
    const [opened, setOpened] = useState(false);
    return (
      <button type="button" onClick={() => setOpened(true)}>
        {opened ? "Contact opened" : "Open contact"}
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
  expect(screen.getByRole("main", { name: "Contacts page" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open contact" }));
  return (
    screen.getByRole("button", { name: "Contact opened" }).textContent ?? ""
  );
}

describe("Contacts framed-view ABI", () => {
  it("keeps signed, /ui, and dynamic loaders compositionally equivalent", async () => {
    await import("./register.ts");
    const registrationCall = registration.register.mock.calls[0]?.[0];
    expect(registrationCall).toBeDefined();

    const [signed, ui, dynamic, raw] = await Promise.all([
      registrationCall.loader(),
      import("./ui.ts"),
      import("./components/contacts-view-bundle.ts"),
      import("./components/ContactsView.tsx"),
    ]);

    expect(signed.default).toBe(ui.ContactsView);
    expect(dynamic.ContactsView).toBe(ui.ContactsView);
    expect(dynamic.ContactsView).not.toBe(raw.ContactsView);
    const signedOutcome = await exercise(signed.default);
    cleanup();
    const dynamicOutcome = await exercise(dynamic.ContactsView);
    expect(dynamicOutcome).toBe(signedOutcome);
  });
});
