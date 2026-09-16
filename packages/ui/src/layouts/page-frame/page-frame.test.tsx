// @vitest-environment jsdom
/**
 * Renders the page frame against each manifest topology and verifies its
 * observable ownership and landmark contract without asserting CSS literals.
 */

import type { PageLayoutManifest } from "@elizaos/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PageFrame } from "./page-frame";

afterEach(cleanup);

const LAYOUTS = [
  {
    kind: "content",
    width: "reading",
    scroll: "shell",
  },
  {
    kind: "content",
    width: "standard",
    scroll: "view",
  },
  {
    kind: "workspace",
    width: "wide",
    scroll: "view",
    gutter: "none",
  },
  {
    kind: "immersive",
    width: "full",
    scroll: "view",
    gutter: "none",
  },
] satisfies readonly PageLayoutManifest[];

describe("PageFrame", () => {
  it.each(LAYOUTS)(
    "exposes the resolved $kind ownership contract",
    (layout) => {
      render(
        <PageFrame data-testid="page-frame" layout={layout}>
          <p>Page body</p>
        </PageFrame>,
      );

      const frame = screen.getByTestId("page-frame");
      expect(frame.getAttribute("data-page-kind")).toBe(layout.kind);
      expect(frame.getAttribute("data-page-topology")).toBe(
        ("topology" in layout ? layout.topology : undefined) ?? "framed",
      );
      expect(frame.getAttribute("data-page-width")).toBe(layout.width);
      expect(frame.getAttribute("data-scroll-owner")).toBe(layout.scroll);

      const content = frame.querySelector("[data-page-content]");
      expect(content).not.toBeNull();
      expect(content?.getAttribute("data-page-gutter")).toBe(
        layout.gutter ?? "standard",
      );
      expect(content?.textContent).toContain("Page body");
    },
  );

  it("defaults to a neutral container when the host already owns main", () => {
    render(
      <main data-testid="host-main">
        <PageFrame layout={LAYOUTS[0]}>
          <section>Nested view</section>
        </PageFrame>
      </main>,
    );

    const hostMain = screen.getByTestId("host-main");
    expect(hostMain.querySelectorAll("main")).toHaveLength(0);
    expect(document.querySelectorAll("main")).toHaveLength(1);
  });

  it("can own the main landmark when the host delegates semantics", () => {
    render(
      <PageFrame as="main" data-testid="page-main" layout={LAYOUTS[0]}>
        <article>Standalone page</article>
      </PageFrame>,
    );

    const pageMain = screen.getByRole("main");
    expect(pageMain).toBe(screen.getByTestId("page-main"));
    expect(document.querySelectorAll("main")).toHaveLength(1);
  });

  it("fails closed when an ambient route attempts to instantiate a frame", () => {
    expect(() =>
      render(
        <PageFrame
          layout={{
            kind: "immersive",
            topology: "ambient",
            width: "full",
            scroll: "view",
            gutter: "none",
          }}
        >
          Ambient content
        </PageFrame>,
      ),
    ).toThrow(/ambient host owns that topology/);
  });

  it("keeps policy markers authoritative when arbitrary attributes are forwarded", () => {
    render(
      <PageFrame
        data-page-kind="incorrect"
        data-page-width="incorrect"
        data-scroll-owner="incorrect"
        data-testid="page-frame"
        layout={LAYOUTS[2]}
      >
        <div>Workspace</div>
      </PageFrame>,
    );

    const frame = screen.getByTestId("page-frame");
    expect(frame.getAttribute("data-page-kind")).toBe("workspace");
    expect(frame.getAttribute("data-page-width")).toBe("wide");
    expect(frame.getAttribute("data-scroll-owner")).toBe("view");
  });
});
