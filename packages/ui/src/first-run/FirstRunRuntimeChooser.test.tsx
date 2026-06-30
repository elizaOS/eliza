// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Z_FIRST_RUN_CHOOSER } from "../lib/floating-layers";
import { FirstRunRuntimeChooserSurface } from "./FirstRunRuntimeChooser";

afterEach(() => {
  cleanup();
});

describe("FirstRunRuntimeChooserSurface", () => {
  it("shows the clean runtime picker with advanced setup collapsed", () => {
    render(
      <FirstRunRuntimeChooserSurface
        appName="elizaOS"
        step="runtime"
        advancedOpen={false}
        busyChoice={null}
        error={null}
        onSelect={vi.fn()}
        onProviderSelect={vi.fn()}
        onToggleAdvanced={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Choose how Eliza should run" }),
    ).toBeTruthy();
    expect(screen.getByText("Sign in with Eliza Cloud")).toBeTruthy();
    expect(screen.getByText("Run on this device")).toBeTruthy();
    expect(screen.getByText("Advanced setup")).toBeTruthy();
    expect(screen.queryByText("Bring your own keys")).toBeNull();
    expect(screen.getByTestId("first-run-runtime-chooser").style.zIndex).toBe(
      String(Z_FIRST_RUN_CHOOSER),
    );
  });

  it("routes primary and advanced choices through callbacks", () => {
    const onSelect = vi.fn();
    const onToggleAdvanced = vi.fn();
    render(
      <FirstRunRuntimeChooserSurface
        appName="elizaOS"
        step="runtime"
        advancedOpen
        busyChoice={null}
        error={null}
        onSelect={onSelect}
        onProviderSelect={vi.fn()}
        onToggleAdvanced={onToggleAdvanced}
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("first-run-chooser-cloud"));
    expect(onSelect).toHaveBeenCalledWith("cloud");

    fireEvent.click(screen.getByText("Advanced setup"));
    expect(onToggleAdvanced).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("first-run-chooser-other"));
    expect(onSelect).toHaveBeenCalledWith("other");
  });

  it("keeps provider selection in the clean chooser surface", () => {
    const onProviderSelect = vi.fn();
    const onBack = vi.fn();
    render(
      <FirstRunRuntimeChooserSurface
        appName="elizaOS"
        step="provider"
        advancedOpen={false}
        busyChoice={null}
        error={null}
        onSelect={vi.fn()}
        onProviderSelect={onProviderSelect}
        onToggleAdvanced={vi.fn()}
        onBack={onBack}
      />,
    );

    expect(screen.getByText("Choose how Eliza should think")).toBeTruthy();
    fireEvent.click(screen.getByTestId("first-run-provider-on-device"));
    expect(onProviderSelect).toHaveBeenCalledWith("on-device");

    fireEvent.click(screen.getByText("Back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
