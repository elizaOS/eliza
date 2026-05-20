// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../avatar-runtime", () => ({
  AvatarHost: () => <div data-testid="avatar-host" />,
}));

import { OnboardingAvatar } from "../OnboardingAvatar";

afterEach(() => cleanup());

describe("OnboardingAvatar", () => {
  it("keeps the decorative avatar from intercepting onboarding controls", () => {
    const { container } = render(<OnboardingAvatar />);
    const wrapper = container.querySelector(".eliza-ob-agent-canvas");

    expect(wrapper).toBeInstanceOf(HTMLElement);
    expect((wrapper as HTMLElement).style.pointerEvents).toBe("none");
    expect(wrapper?.getAttribute("aria-hidden")).toBe("true");
  });
});
