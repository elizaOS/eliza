/**
 * Guards the boot-registration contract for the Todos dashboard view. The agent
 * boot loader imports `@elizaos/plugin-todos/plugin` (this package's `./plugin`
 * subpath, i.e. `src/plugin.ts`) and feeds its default export to
 * `registerPluginViews`, which registers nothing when `views` is empty. If the
 * view metadata lives only on the `index.ts` wrapper the boot path never
 * imports, the "todos" view is absent from `/api/views` and VIEWS(view="todos")
 * fails with "No view matches todos". This test asserts the boot-imported
 * export carries the "todos" view with the bundle metadata the registry
 * consumes, mirroring how notes/calendar ship their views on the same export.
 */

import { describe, expect, test } from "vitest";
import bootPlugin, { todosPlugin, todosRuntimePlugin } from "../src/plugin.js";

describe("Todos boot-registration view contract", () => {
  test("the boot-imported `/plugin` default export declares the todos view", () => {
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
