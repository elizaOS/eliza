// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppHero, AppIdentityTile } from "./app-identity";

describe("app identity visuals", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a generated hero image when an app does not ship one", () => {
    const app = {
      name: "@acme/app-mystery",
      displayName: "Mystery App",
      description: "An app with no packaged artwork.",
      category: "utility",
      icon: null,
      heroImage: null,
    };

    const hero = render(<AppHero app={app} />);
    const tile = render(<AppIdentityTile app={app} />);

    expect(
      hero.container.querySelector('img[src^="data:image/svg+xml"]'),
    ).not.toBeNull();
    expect(
      tile.container.querySelector('img[src^="data:image/svg+xml"]'),
    ).not.toBeNull();
  });

  it("can render image-only widgets without badge overlays", () => {
    const app = {
      name: "@acme/app-mystery",
      displayName: "Mystery App",
      description: "An app with packaged artwork.",
      category: "utility",
      icon: null,
      heroImage: "/heroes/mystery.png",
    };

    const hero = render(<AppHero app={app} imageOnly />);
    const tile = render(<AppIdentityTile app={app} imageOnly />);

    expect(
      hero.container.querySelector('img[src="/heroes/mystery.png"]'),
    ).not.toBeNull();
    expect(
      tile.container.querySelector('img[src="/heroes/mystery.png"]'),
    ).not.toBeNull();
    expect(hero.container.textContent?.trim()).toBe("");
    expect(tile.container.textContent?.trim()).toBe("");
  });
});
