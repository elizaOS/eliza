/**
 * Coverage for detail extension registry.
 */
import { describe, expect, it } from "vitest";

import {
  getAppDetailExtension,
  registerDetailExtension,
} from "./detail-extension-registry.js";

describe("detail-extension-registry", () => {
  it("registers and retrieves via app object", () => {
    const ext = { id: "test-ext-2" } as never;
    registerDetailExtension("panel-test-2", ext);
    const app = { uiExtension: { detailPanelId: "panel-test-2" } } as never;
    expect(getAppDetailExtension(app)).toBe(ext);
  });

  it("returns null for unknown", () => {
    const app = { uiExtension: { detailPanelId: "unknown-xyz-9999" } } as never;
    expect(getAppDetailExtension(app)).toBeNull();
  });

  it("returns null when no uiExtension", () => {
    expect(getAppDetailExtension({} as never)).toBeNull();
    expect(getAppDetailExtension({ uiExtension: null } as never)).toBeNull();
  });

  it("overwrites existing", () => {
    const ext1 = { id: "ext1" } as never;
    const ext2 = { id: "ext2" } as never;
    registerDetailExtension("panel-overwrite-2", ext1);
    registerDetailExtension("panel-overwrite-2", ext2);
    const app = { uiExtension: { detailPanelId: "panel-overwrite-2" } } as never;
    expect(getAppDetailExtension(app)).toBe(ext2);
  });
});
