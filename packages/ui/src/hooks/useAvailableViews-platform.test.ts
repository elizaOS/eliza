/** Regression coverage for enforcing native dynamic-view policy in the client catalog. */

import { describe, expect, it } from "vitest";
import {
  enforceDynamicViewPolicy,
  type ViewRegistryEntry,
} from "./useAvailableViews";

const signedInProcessView: ViewRegistryEntry = {
  id: "settings",
  label: "Settings",
  path: "/settings",
  pluginName: "@elizaos/builtin",
  available: true,
};
const remoteNotes: ViewRegistryEntry = {
  id: "notes",
  label: "Notes",
  path: "/notes",
  pluginName: "@elizaos/plugin-notes",
  bundleUrl: "/api/views/notes/bundle.js",
  available: true,
};
const remoteFrame: ViewRegistryEntry = {
  id: "remote-frame",
  label: "Remote frame",
  path: "/remote-frame",
  pluginName: "@local/remote-frame",
  frameUrl: "/api/views/remote-frame/frame.html",
  available: true,
};

describe("enforceDynamicViewPolicy", () => {
  it("removes leaked remote bundles and frames on restricted native clients", () => {
    expect(
      enforceDynamicViewPolicy(
        [signedInProcessView, remoteNotes, remoteFrame],
        false,
      ),
    ).toEqual([signedInProcessView]);
  });

  it("preserves remote views on web and desktop clients", () => {
    expect(
      enforceDynamicViewPolicy(
        [signedInProcessView, remoteNotes, remoteFrame],
        true,
      ),
    ).toEqual([signedInProcessView, remoteNotes, remoteFrame]);
  });
});
