/**
 * @vitest-environment jsdom
 *
 * Exercises the renderer-safe browser facade: the settings-card wrappers must
 * return React elements that carry their props through to the concrete
 * implementations, `registerLifeOpsApp` is an intentional no-op, and the GitHub
 * callback dispatcher is re-exported unchanged. Concrete components and the
 * client side-effect import are stubbed so the facade's own bodies are what run.
 */

import { isValidElement as reactIsValidElement } from "react";
import { describe, expect, it, vi } from "vitest";

function AppBlockerImpl(): null {
  return null;
}
function WebsiteBlockerImpl(): null {
  return null;
}
const dispatchSpy = vi.hoisted(() => vi.fn());

vi.mock("./api/client-lifeops.js", () => ({}));
vi.mock("./components/AppBlockerSettingsCard.js", () => ({
  AppBlockerSettingsCard: AppBlockerImpl,
}));
vi.mock("./components/WebsiteBlockerSettingsCard.js", () => ({
  WebsiteBlockerSettingsCard: WebsiteBlockerImpl,
}));
vi.mock("./platform/lifeops-github.js", () => ({
  dispatchQueuedLifeOpsGithubCallbackFromUrl: dispatchSpy,
}));

import {
  AppBlockerSettingsCard,
  dispatchQueuedLifeOpsGithubCallbackFromUrl,
  registerLifeOpsApp,
  WebsiteBlockerSettingsCard,
} from "./ui.js";

describe("plugin-personal-assistant browser facade", () => {
  it("wraps the app-blocker settings card, forwarding props to the impl", () => {
    const props = { mode: "app" } as never;
    const element = AppBlockerSettingsCard(props);

    expect(reactIsValidElement(element)).toBe(true);
    expect(element.type).toBe(AppBlockerImpl);
    expect(element.props).toEqual({ mode: "app" });
  });

  it("wraps the website-blocker settings card, forwarding props to the impl", () => {
    const props = { mode: "website" } as never;
    const element = WebsiteBlockerSettingsCard(props);

    expect(reactIsValidElement(element)).toBe(true);
    expect(element.type).toBe(WebsiteBlockerImpl);
    expect(element.props).toEqual({ mode: "website" });
  });

  it("registerLifeOpsApp is a safe no-op returning undefined", () => {
    expect(registerLifeOpsApp()).toBeUndefined();
  });

  it("re-exports the queued GitHub callback dispatcher unchanged", () => {
    expect(dispatchQueuedLifeOpsGithubCallbackFromUrl).toBe(dispatchSpy);
    dispatchQueuedLifeOpsGithubCallbackFromUrl();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });
});
