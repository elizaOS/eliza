/** Verifies the semantic structures used by trajectory Storybook surfaces. */
// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TrajectoryCacheStats } from "./trajectory-cache-stats";
import { TrajectoryCodeBlock } from "./trajectory-code-block";

describe("trajectory accessibility structure", () => {
  afterEach(cleanup);

  it("keeps every definition-list group limited to terms and details", () => {
    const { container } = render(
      <TrajectoryCacheStats
        heading="Cache"
        metrics={[
          {
            id: "hits",
            label: "Hits",
            value: "4",
            meta: "Across two requests",
          },
        ]}
      />,
    );

    const group = container.querySelector("dl > div");
    expect(group).not.toBeNull();
    expect(
      Array.from(group?.children ?? []).map((node) => node.tagName),
    ).toEqual(["DT", "DD", "DD"]);
  });

  it("gives a labelled code attachment an explicit region role", () => {
    const { container } = render(
      <TrajectoryCodeBlock
        collapseLabel="Collapse"
        content=""
        copyLabel="Copy"
        expandLabel="Expand"
        label="Response"
        linesLabel="0 lines"
        onCopy={vi.fn()}
      />,
    );

    const code = container.querySelector("pre");
    expect(code?.getAttribute("role")).toBe("region");
    expect(code?.getAttribute("aria-label")).toBe("Response");
  });
});
