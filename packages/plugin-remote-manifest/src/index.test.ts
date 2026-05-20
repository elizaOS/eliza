import { describe, expect, it } from "bun:test";
import {
  buildRemotePluginRuntimeContext,
  RemotePluginStoreError,
  loadRemotePluginListEntries,
  loadRemotePluginStoreSnapshot,
  toRemotePluginListEntry,
  toInstalledRemotePluginSnapshot,
} from "./index.js";

describe("remote plugin package barrel", () => {
  it("exports public store snapshot helpers", () => {
    expect(typeof RemotePluginStoreError).toBe("function");
    expect(typeof buildRemotePluginRuntimeContext).toBe("function");
    expect(typeof loadRemotePluginListEntries).toBe("function");
    expect(typeof loadRemotePluginStoreSnapshot).toBe("function");
    expect(typeof toRemotePluginListEntry).toBe("function");
    expect(typeof toInstalledRemotePluginSnapshot).toBe("function");
  });
});
