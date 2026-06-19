// @vitest-environment jsdom
//
// Render test for ImageGenAppView. Mounts the real component with `@elizaos/app-core`
// UI primitives stubbed (matching hyperliquid's render-test pattern) and the
// waifu invoke client mocked so no network is touched. Asserts the shell mounts,
// the prompt field + aspect/model controls render, the generate button gates on
// a valid prompt, and a successful generate renders the returned image + the
// settled charge read straight off the DTO (no client-side price math).

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageGenResult } from "./imagegen-contracts";

vi.mock("@elizaos/app-core", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }, children),
  PagePanel: {
    Notice: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", { "data-testid": "notice" }, children),
  },
  Spinner: (props: React.HTMLAttributes<HTMLSpanElement>) =>
    React.createElement("span", { "data-testid": "spinner", ...props }),
}));

const invokeImageGen = vi.hoisted(() => vi.fn());
vi.mock("./imagegen-client", () => ({ invokeImageGen }));

import { ImageGenAppView } from "./ImageGenAppView";

const RESULT: ImageGenResult = {
  appId: "image-gen",
  elizaCloudAppId: "cloud-app-1",
  agentTokenAddress: "0xabc",
  imageUrl: "https://cdn.example/img.png",
  prompt: "a neon city at dusk",
  aspect: "16:9",
  charge: {
    status: "settled",
    currency: "usd",
    baseCost: 0.01,
    creatorMarkup: 0.005,
    totalCost: 0.015,
    creatorEarnings: 0.005,
    balance: 4.2,
  },
  earnings: null,
  billingReality: "charged",
};

function ctx() {
  return {
    exitToApps: vi.fn(),
    uiTheme: "dark" as const,
    t: (key: string) => key,
  };
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__WAIFU_IMAGEGEN__ = {
    apiBase: "https://waifu.test",
    agentTokenAddress: "0xabc",
    stewardJwt: "jwt-token",
    metadata: { inferenceMarkupPercentage: 20, model: "GPT Image 2" },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as unknown as Record<string, unknown>).__WAIFU_IMAGEGEN__;
});

describe("ImageGenAppView", () => {
  it("mounts the shell with the prompt field, aspect, and model controls", () => {
    const { container } = render(React.createElement(ImageGenAppView, ctx()));

    expect(
      container.querySelector('[data-testid="imagegen-shell"]'),
    ).toBeTruthy();
    expect(
      screen.getByPlaceholderText("describe the image you want"),
    ).toBeTruthy();
    // Aspect + model option buttons render from the contract constants.
    expect(screen.getByRole("button", { name: "1:1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "GPT Image 2" })).toBeTruthy();
    // Host metadata markup is read straight off the DTO and rendered.
    expect(screen.getByText("+20%")).toBeTruthy();
  });

  it("disables generate until the prompt is valid, then invokes and renders the image + settled charge", async () => {
    invokeImageGen.mockResolvedValue(RESULT);
    render(React.createElement(ImageGenAppView, ctx()));

    const generate = screen.getByRole("button", { name: /generate/i });
    expect((generate as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(
      screen.getByPlaceholderText("describe the image you want"),
      {
        target: { value: "a neon city at dusk" },
      },
    );
    expect((generate as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(generate);

    const img = await screen.findByAltText("a neon city at dusk");
    expect(img.getAttribute("src")).toBe("https://cdn.example/img.png");
    expect(invokeImageGen).toHaveBeenCalledTimes(1);
    // The settled total is the DTO field formatted for display, not computed.
    expect(screen.getByText("$0.0150")).toBeTruthy();
  });

  it("warns when no agent token is configured", () => {
    delete (window as unknown as Record<string, unknown>).__WAIFU_IMAGEGEN__;
    render(React.createElement(ImageGenAppView, ctx()));
    expect(
      screen.getByText("No agent is configured for image generation."),
    ).toBeTruthy();
    expect(invokeImageGen).not.toHaveBeenCalled();
  });

  it("renders the typed error notice when the invoke rejects", async () => {
    invokeImageGen.mockRejectedValue({
      kind: "insufficient-credits",
      status: 402,
      message: "not enough credits to generate",
    });
    render(React.createElement(ImageGenAppView, ctx()));

    fireEvent.change(
      screen.getByPlaceholderText("describe the image you want"),
      {
        target: { value: "a neon city at dusk" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(screen.getByText("not enough credits to generate")).toBeTruthy();
    });
  });
});
