// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ShaderBackground } from "./ShaderBackground";

type ShaderRuntimeWindow = Window & {
  __ELIZA_ELECTROBUN_RPC__?: unknown;
  __electrobunWindowId?: number;
  __electrobunWebviewId?: number;
};

describe("ShaderBackground", () => {
  afterEach(() => {
    const runtimeWindow = window as ShaderRuntimeWindow;
    delete runtimeWindow.__ELIZA_ELECTROBUN_RPC__;
    delete runtimeWindow.__electrobunWindowId;
    delete runtimeWindow.__electrobunWebviewId;
    cleanup();
  });

  it("keeps the animated rim on ordinary web renderers", () => {
    render(<ShaderBackground color="#ff5800" />);

    const background = screen.getByTestId("app-background-shader");
    expect(background.getAttribute("data-eliza-bg-motion")).toBe("animated");
    expect(background.className).not.toContain("app-bg-shader-static");
  });

  it("stills the rim animation in Electrobun/WebKitGTK", () => {
    (window as ShaderRuntimeWindow).__ELIZA_ELECTROBUN_RPC__ = {};

    render(<ShaderBackground color="#ff5800" />);

    const background = screen.getByTestId("app-background-shader");
    expect(background.getAttribute("data-eliza-bg-motion")).toBe("static");
    expect(background.className).toContain("app-bg-shader-static");
  });
});
