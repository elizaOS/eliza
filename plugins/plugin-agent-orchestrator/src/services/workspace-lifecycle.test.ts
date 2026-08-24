/**
 * Unit tests for workspace lifecycle: validates workspace salvage registration.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { preserveRegisteredWorkspace } from "./workspace-lifecycle.ts";
import type { WorkspaceRegistry } from "./workspace-registry.js";

describe("workspace-lifecycle", () => {
  it("returns false and logs when workspace is not registered", () => {
    const logs: string[] = [];
    const fakeRegistry = {
      list: () => [],
      register: () => {},
    } as unknown as WorkspaceRegistry;

    const res = preserveRegisteredWorkspace(
      "/tmp/unregistered",
      fakeRegistry,
      (m) => logs.push(m),
    );
    expect(res).toBe(false);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("unregistered");
  });

  it("re-registers and preserves registered workspace for salvage", () => {
    const dirPath = "/tmp/registered-ws";
    const resolved = path.resolve(dirPath);
    const logs: string[] = [];
    let registered = false;

    const fakeRegistry = {
      list: () => [{ kind: "task", path: resolved, ownerId: "agent-1" }],
      register: () => {
        registered = true;
      },
    } as unknown as WorkspaceRegistry;

    const res = preserveRegisteredWorkspace(dirPath, fakeRegistry, (m) =>
      logs.push(m),
    );
    expect(res).toBe(true);
    expect(registered).toBe(true);
    expect(logs[0]).toContain("Preserved workspace");
  });
});
