// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BackgroundHost } from "../BackgroundHost";
import { SKY_BACKGROUND_COLOR } from "../types";

afterEach(() => {
  cleanup();
});

describe("BackgroundHost", () => {
  it("renders a single static solid background element", () => {
    const { container } = render(<BackgroundHost />);
    const host = container.querySelector<HTMLElement>(
      "[data-eliza-background-host]",
    );
    expect(host).not.toBeNull();
    if (!host) throw new Error("background host element missing");
    expect(host.dataset.elizaBg).toBe("solid");
    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(host.style.background).toContain("var(--background");
    expect(host.style.background).toContain(SKY_BACKGROUND_COLOR);
  });

  it("never mounts a video or animation surface", () => {
    const { container } = render(<BackgroundHost />);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector("style")).toBeNull();
  });

  it("forwards the className prop", () => {
    const { container } = render(<BackgroundHost className="shell-bg" />);
    const host = container.querySelector<HTMLElement>(
      "[data-eliza-background-host]",
    );
    expect(host?.classList.contains("shell-bg")).toBe(true);
  });
});
