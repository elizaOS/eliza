// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetHomeDismissalsForTests,
  recordHomeWidgetSeen,
} from "../../widgets/home-dismissal-store";
import { HOME_GESTURE_HINT_KEY, HomeGestureHint } from "./HomeGestureHint";

afterEach(() => {
  cleanup();
  __resetHomeDismissalsForTests();
});

describe("HomeGestureHint", () => {
  it("shows the lightweight gesture hint on the first session", () => {
    render(<HomeGestureHint />);

    expect(screen.getByTestId("home-gesture-hint").textContent).toContain(
      "Swipe for apps. Pull chat up.",
    );
  });

  it("dismisses permanently through the home dismissal store", () => {
    render(<HomeGestureHint />);

    fireEvent.click(screen.getByLabelText("Dismiss gesture hint"));

    expect(screen.queryByTestId("home-gesture-hint")).toBeNull();
    const raw = JSON.parse(
      localStorage.getItem("eliza:home-dismissed:v1") ?? "{}",
    );
    expect(raw[HOME_GESTURE_HINT_KEY]).toMatchObject({ dismissed: true });
  });

  it("stays retired after it has already been seen once", () => {
    recordHomeWidgetSeen(HOME_GESTURE_HINT_KEY);

    render(<HomeGestureHint />);

    expect(screen.queryByTestId("home-gesture-hint")).toBeNull();
  });
});
