/** Verifies the root plugin descriptor retains the host-discoverable dashboard bundle. */

import bootPlugin, {
  todosPlugin,
  todosRuntimePlugin,
} from "@elizaos/plugin-todos";
import { describe, expect, test } from "vitest";

describe("Todos boot-registration view contract", () => {
  test("the boot-imported root default export declares the todos view", () => {
    expect(bootPlugin).toBe(todosPlugin);
    expect(todosRuntimePlugin.views ?? []).toHaveLength(0);
    expect(bootPlugin.views).toHaveLength(1);

    const views = bootPlugin.views ?? [];
    const todosView = views.find((view) => view.id === "todos");

    expect(todosView).toBeDefined();
    // registerPluginViews resolves bundlePath relative to the package root and
    // renders `componentExport` from that bundle; both must be present or the
    // registered entry cannot mount.
    expect(todosView?.bundlePath).toBe("dist/views/bundle.js");
    expect(todosView?.componentExport).toBe("TodosView");
    expect(todosView?.path).toBe("/todos");
  });
});
