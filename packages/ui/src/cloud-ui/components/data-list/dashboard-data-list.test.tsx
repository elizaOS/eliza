/**
 * Dashboard data-list responsive wrappers: the desktop shell must not depend on
 * a base `hidden` utility because the app bundle can load another `.hidden`
 * rule after the responsive breakpoint rule.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DashboardDataListDesktop,
  DashboardDataListMobile,
} from "./dashboard-data-list";

describe("DashboardDataList responsive wrappers", () => {
  it("hides the desktop list only below md so later base hidden rules cannot mask it", () => {
    const markup = renderToStaticMarkup(
      <DashboardDataListDesktop>
        <div>Desktop content</div>
      </DashboardDataListDesktop>,
    );
    const className = markup.match(/class="([^"]+)"/)?.[1] ?? "";

    expect(className.split(/\s+/)).toContain("max-md:hidden");
    expect(className.split(/\s+/)).not.toContain("hidden");
    expect(className.split(/\s+/)).not.toContain("md:block");
  });

  it("keeps the mobile list hidden at and above md", () => {
    const markup = renderToStaticMarkup(
      <DashboardDataListMobile>
        <div>Mobile content</div>
      </DashboardDataListMobile>,
    );
    const className = markup.match(/class="([^"]+)"/)?.[1] ?? "";

    expect(className.split(/\s+/)).toContain("md:hidden");
  });
});
