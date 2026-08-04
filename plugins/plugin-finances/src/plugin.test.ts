/**
 * Finances plugin contract tests pin the view registration and named component
 * export consumed by the app view loader.
 */

import { describe, expect, it } from "vitest";
import { financesPlugin } from "./plugin.ts";

describe("financesPlugin view registration", () => {
  it("registers exactly one view pointing at the /finances dashboard", () => {
    expect(financesPlugin.views).toHaveLength(1);

    const view = financesPlugin.views?.[0];
    expect(view?.id).toBe("finances");
    expect(view?.path).toBe("/finances");
    expect(view?.bundlePath).toBe("dist/views/bundle.js");
    expect(view?.componentExport).toBe("FinancesView");
  });
});
