/**
 * Pins the shell's root-path contract on a non-marketing host: `/` belongs to
 * the same catch-all route as every other app path, so client navigation out of
 * `/` reconciles the app subtree instead of remounting it.
 *
 * A dedicated `/` route regressed this — react-router swapped route elements on
 * `/` → `/chat`, remounting the app and discarding its mount-time URL state, so
 * `?shellMode=` surfaces (voice self-test, voice workbench, kiosk) were torn
 * down moments after they mounted. Real jsdom render of the shipped shell.
 */
// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetPrivateCloudRegistrationForTests } from "../private-cloud-registration";
import { registerPublicCloudSurfaces } from "../register-public";
import { CloudRouterShell } from "./CloudRouterShell";

let mounts = 0;

function AppProbe(): React.JSX.Element {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <div data-testid="app-probe" />;
}

function navigate(path: string): void {
  act(() => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

afterEach(() => {
  cleanup();
  resetPrivateCloudRegistrationForTests();
});

beforeEach(() => {
  mounts = 0;
  registerPublicCloudSurfaces();
  window.history.pushState({}, "", "/");
});

describe("CloudRouterShell root route", () => {
  it("renders the app at `/` on a non-marketing host even when a marketing homepage is supplied", () => {
    render(
      <CloudRouterShell
        appElement={<AppProbe />}
        marketingHomeElement={<div data-testid="marketing-home" />}
      />,
    );

    expect(screen.getByTestId("app-probe")).toBeTruthy();
    expect(screen.queryByTestId("marketing-home")).toBeNull();
  });

  it("keeps the app mounted across `/` → `/chat` so mount-time URL state survives", () => {
    render(
      <CloudRouterShell
        appElement={<AppProbe />}
        marketingHomeElement={<div data-testid="marketing-home" />}
      />,
    );
    expect(mounts).toBe(1);

    navigate("/chat");

    expect(screen.getByTestId("app-probe")).toBeTruthy();
    expect(mounts).toBe(1);
  });
});
