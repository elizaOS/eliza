// @vitest-environment jsdom

/**
 * Verifies the Contacts host-view ABI with real module entry paths and a
 * deterministic render seam. Signed and `/ui` entry points own native page
 * chrome; the dynamic bundle stays embeddable because its host owns that chrome.
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

async function exercise(
  component: React.ComponentType,
  expectedFrame: "framed" | "embeddable",
): Promise<string> {
  render(React.createElement(component));
  const frame = screen.queryByRole("main", { name: "Contacts page" });
  expect(frame === null ? "embeddable" : "framed").toBe(expectedFrame);
  fireEvent.click(screen.getByRole("button", { name: "Open contact" }));
  return (
    screen.getByRole("button", { name: "Contact opened" }).textContent ?? ""
  );
}

describe("Contacts host-view ABI", () => {
  it("keeps native entry points framed and the dynamic bundle embeddable", async () => {
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
    expect(dynamic.ContactsView).toBe(raw.ContactsView);
    expect(dynamic.ContactsView).not.toBe(ui.ContactsView);
    const signedOutcome = await exercise(signed.default, "framed");
    cleanup();
    const dynamicOutcome = await exercise(dynamic.ContactsView, "embeddable");
    expect(dynamicOutcome).toBe(signedOutcome);
  });
});
