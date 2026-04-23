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
});
