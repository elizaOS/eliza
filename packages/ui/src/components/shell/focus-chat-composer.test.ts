/**
 * Verifies the real DOM lifecycle contract for delayed desktop chat-composer
 * mounting without mocking the observer that detects the committed textarea.
 */
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { focusChatComposerWhenReady } from "./focus-chat-composer";

describe("focusChatComposerWhenReady", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("preserves focus intent until a delayed composer mount", async () => {
    const onFocused = vi.fn();
    const stop = focusChatComposerWhenReady(onFocused);
    const composer = document.createElement("textarea");
    composer.dataset.testid = "chat-composer-textarea";

    document.body.append(composer);
    await vi.waitFor(() => expect(onFocused).toHaveBeenCalledOnce());

    expect(document.activeElement).toBe(composer);
    stop();
  });

  it("focuses an existing composer once and does not react after cleanup", async () => {
    const composer = document.createElement("textarea");
    composer.dataset.testid = "chat-composer-textarea";
    document.body.append(composer);
    const onFocused = vi.fn();

    const stop = focusChatComposerWhenReady(onFocused);
    expect(onFocused).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(composer);

    stop();
    composer.remove();
    const replacement = document.createElement("textarea");
    replacement.dataset.testid = "chat-composer-textarea";
    document.body.append(replacement);
    await Promise.resolve();
    expect(onFocused).toHaveBeenCalledOnce();
  });
});
