/**
 * Runtime chooser override tests cover the packaged-desktop-only guard and URL
 * cleanup for both browser and hash-router entrypoints.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyRuntimeChooserOverrideFromUrl,
  removeUrlParameter,
} from "./runtime-chooser-override";

describe("runtime chooser override", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    window.__ELIZA_DESKTOP_TEST_ENABLE_RUNTIME_CHOOSER__ = undefined;
  });

  it("ignores a user-controlled URL param without the packaged test injection", () => {
    window.history.replaceState(null, "", "/?enableRuntimeChooser=1");

    expect(applyRuntimeChooserOverrideFromUrl()).toBe(false);

    expect(
      window.localStorage.getItem("eliza:enable-runtime-chooser"),
    ).toBeNull();
    expect(window.location.search).toBe("?enableRuntimeChooser=1");
  });

  it("persists and removes the URL param when the packaged test injection is present", () => {
    window.__ELIZA_DESKTOP_TEST_ENABLE_RUNTIME_CHOOSER__ = true;
    window.history.replaceState(
      { from: "test" },
      "",
      "/?enableRuntimeChooser=1&runtime=first-run",
    );

    expect(applyRuntimeChooserOverrideFromUrl()).toBe(true);

    expect(window.localStorage.getItem("eliza:enable-runtime-chooser")).toBe(
      "1",
    );
    expect(window.location.href).toBe(
      `${window.location.origin}/?runtime=first-run`,
    );
  });

  it("removes query params from hash-router URLs too", () => {
    const next = removeUrlParameter(
      `${window.location.origin}/#/chat?enableRuntimeChooser=1&runtime=first-run`,
      "enableRuntimeChooser",
    );

    expect(next.href).toBe(
      `${window.location.origin}/#/chat?runtime=first-run`,
    );
  });
});
