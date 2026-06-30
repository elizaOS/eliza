// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Z_FIRST_RUN_CHOOSER } from "../lib/floating-layers";
import {
  FirstRunRuntimeChooserSurface,
  hasPendingFirstRunBackupRestoreChoice,
  isSyntheticFirstRunChoiceTurn,
} from "./FirstRunRuntimeChooser";

afterEach(() => {
  cleanup();
});

describe("FirstRunRuntimeChooserSurface", () => {
  it("identifies synthetic in-chat first-run choice turns", () => {
    expect(
      isSyntheticFirstRunChoiceTurn({
        id: "first-run:greeting",
        content: "[CHOICE:first-run id=runtime]",
      }),
    ).toBe(true);
    expect(
      isSyntheticFirstRunChoiceTurn({
        id: "first-run:error:123",
        content:
          "Couldn't connect.\n\n[CHOICE:first-run id=runtime]\n__first_run__:runtime:cloud=Eliza Cloud\n[/CHOICE]",
      }),
    ).toBe(true);
    expect(
      isSyntheticFirstRunChoiceTurn({
        id: "first-run:provider",
        content: "[CHOICE:first-run id=provider]",
      }),
    ).toBe(true);
    expect(
      isSyntheticFirstRunChoiceTurn({
        id: "first-run:backup-restore",
        content: "[CHOICE:first-run id=backup-restore]",
      }),
    ).toBe(false);
    expect(
      isSyntheticFirstRunChoiceTurn({
        id: "first-run:greeting",
        text: "[CHOICE:first-run id=runtime]",
      }),
    ).toBe(true);
    expect(
      isSyntheticFirstRunChoiceTurn({
        id: "first-run:status:Saving first-run profile",
        content: "Saving first-run profile",
      }),
    ).toBe(false);
    expect(
      isSyntheticFirstRunChoiceTurn({
        id: "regular-message",
        content: "[CHOICE:first-run id=runtime]",
      }),
    ).toBe(false);
  });

  it("detects a pending backup restore choice before runtime setup starts", () => {
    expect(
      hasPendingFirstRunBackupRestoreChoice([
        {
          id: "first-run:backup-restore",
          text: "Restore?\n\n[CHOICE:first-run id=backup-restore]\n[/CHOICE]",
        },
      ]),
    ).toBe(true);
    expect(
      hasPendingFirstRunBackupRestoreChoice([
        {
          id: "first-run:backup-restore-error:1",
          text: "Try again\n\n[CHOICE:first-run id=backup-restore]\n[/CHOICE]",
        },
      ]),
    ).toBe(true);
    expect(
      hasPendingFirstRunBackupRestoreChoice([
        {
          id: "first-run:backup-restore",
          text: "Restore?\n\n[CHOICE:first-run id=backup-restore]\n[/CHOICE]",
        },
        {
          id: "first-run:greeting",
          text: "Hi — I'm Eliza. Choose a setup option to continue.",
        },
      ]),
    ).toBe(false);
  });

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
