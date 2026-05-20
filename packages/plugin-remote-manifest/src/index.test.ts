import { describe, expect, it } from "bun:test";
import {
  buildCarrotRuntimeContext,
  RemotePluginStoreError,
  loadCarrotListEntries,
  loadCarrotStoreSnapshot,
  toRemotePluginListEntry,
  toInstalledRemotePluginSnapshot,
} from "./index.js";

describe("remote plugin package barrel", () => {
  it("exports public store snapshot helpers", () => {
    expect(typeof RemotePluginStoreError).toBe("function");
    expect(typeof buildCarrotRuntimeContext).toBe("function");
    expect(typeof loadCarrotListEntries).toBe("function");
    expect(typeof loadCarrotStoreSnapshot).toBe("function");
    expect(typeof toRemotePluginListEntry).toBe("function");
    expect(typeof toInstalledRemotePluginSnapshot).toBe("function");
  });
});
