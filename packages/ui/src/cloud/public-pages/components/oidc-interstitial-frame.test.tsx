/**
 * Geometry and semantic-token contract for every hosted OIDC interstitial.
 * The jsdom harness verifies the shared frame rather than browser pixels.
 */
// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  OIDC_INTERSTITIAL_STYLE_TOKENS,
  OidcInterstitialFrame,
} from "./oidc-interstitial-frame";

describe("OidcInterstitialFrame", () => {
  it("holds the hosted login card geometry on every OIDC state", () => {
    render(
      <OidcInterstitialFrame>
        <h1>Authentication state</h1>
      </OidcInterstitialFrame>,
    );

    const viewport = screen.getByRole("main");
    const card = document.querySelector('[data-oidc-interstitial="card"]');
    const content = document.querySelector(
      '[data-oidc-interstitial="content"]',
    );

    expect(viewport.className).toBe(OIDC_INTERSTITIAL_STYLE_TOKENS.viewport);
    expect(card?.className).toBe(OIDC_INTERSTITIAL_STYLE_TOKENS.card);
    expect(content?.className).toBe(OIDC_INTERSTITIAL_STYLE_TOKENS.content);
    expect(card?.classList.contains("max-w-md")).toBe(true);
    expect(card?.classList.contains("rounded-xl")).toBe(true);
    expect(card?.classList.contains("p-6")).toBe(true);
    expect(card?.classList.contains("md:p-8")).toBe(true);
  });

  it("keeps actions theme-driven with the darker orange hover token", () => {
    expect(OIDC_INTERSTITIAL_STYLE_TOKENS.primaryAction).toContain("bg-accent");
    expect(OIDC_INTERSTITIAL_STYLE_TOKENS.primaryAction).toContain(
      "text-accent-foreground",
    );
    expect(OIDC_INTERSTITIAL_STYLE_TOKENS.primaryAction).toContain(
      "hover:bg-accent-hover",
    );
    expect(OIDC_INTERSTITIAL_STYLE_TOKENS.primaryAction).not.toMatch(
      /hover:bg-(?:black|white|background|foreground)/,
    );
  });
});
