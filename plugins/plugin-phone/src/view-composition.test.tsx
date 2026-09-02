// @vitest-environment jsdom

/**
 * Verifies the Phone host-view ABI with real module entry paths and a
 * deterministic render seam. Signed, `/ui`, and dynamic entry points must mount
 * the same framed page while the underlying dialer view stays interactive.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const registration = vi.hoisted(() => ({ register: vi.fn() }));

vi.mock("@elizaos/ui/app-shell-registry", () => ({
  registerAppShellPage: registration.register,
}));
vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, getPlatform: () => "android" },
  };
});
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
vi.mock("./components/PhoneView.tsx", () => ({
  PhoneView: () => {
    const [dialed, setDialed] = useState(false);
    return (
      <button type="button" onClick={() => setDialed(true)}>
        {dialed ? "Number dialed" : "Dial number"}
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
  expect(screen.getByRole("main", { name: "Phone page" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dial number" }));
  return (
    screen.getByRole("button", { name: "Number dialed" }).textContent ?? ""
  );
}

describe("Phone framed-view ABI", () => {
  it("keeps signed, /ui, and dynamic loaders compositionally equivalent", async () => {
    await import("./register-phone-page.ts");
    const registrationCall = registration.register.mock.calls[0]?.[0];
    expect(registrationCall).toBeDefined();

    const [signed, ui, dynamic, raw] = await Promise.all([
      registrationCall.loader(),
      import("./ui.ts"),
      import("./components/phone-view-bundle.ts"),
      import("./components/PhoneView.tsx"),
    ]);

    expect(signed.default).toBe(ui.PhoneView);
    expect(dynamic.PhoneView).toBe(ui.PhoneView);
    expect(dynamic.PhoneView).not.toBe(raw.PhoneView);
    const signedOutcome = await exercise(signed.default);
    cleanup();
    const dynamicOutcome = await exercise(dynamic.PhoneView);
    expect(dynamicOutcome).toBe(signedOutcome);
  });
});
