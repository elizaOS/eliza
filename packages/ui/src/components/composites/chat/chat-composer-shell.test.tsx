// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatComposerShell } from "./chat-composer-shell";

afterEach(cleanup);

describe("ChatComposerShell", () => {
  it("keeps the default composer from collapsing inside flex chat layouts", () => {
    const { container } = render(
      <ChatComposerShell>
        <div>Composer</div>
      </ChatComposerShell>,
    );

    expect(container.firstElementChild?.className).toContain("shrink-0");
  });

  it("keeps the game-modal composer from collapsing inside overlay layouts", () => {
    const { container } = render(
      <ChatComposerShell variant="game-modal">
        <div>Composer</div>
      </ChatComposerShell>,
    );

    expect(container.firstElementChild?.className).toContain("shrink-0");
  });
});
