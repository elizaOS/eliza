/**
 * Verifies the Release Center's semantic metadata-list contract with the real
 * React components under the deterministic application provider.
 */

// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MockAppProvider } from "../../storybook/mock-providers";
import { DefinitionList, DefinitionRow } from "./shared";

describe("DefinitionList", () => {
  it("renders metadata as a definition list with quiet row separators", () => {
    const { container } = render(
      <MockAppProvider>
        <DefinitionList>
          <DefinitionRow label="Platform" value="darwin" />
          <DefinitionRow label="Architecture" value="arm64" />
        </DefinitionList>
      </MockAppProvider>,
    );

    const list = container.querySelector("dl");
    expect(list?.className).toContain("divide-y");
    expect(list?.className).toContain("divide-border/60");
    expect(screen.getByText("Platform").tagName).toBe("DT");
    expect(screen.getByText("darwin").tagName).toBe("DD");
    expect(screen.getByText("Architecture").tagName).toBe("DT");
    expect(screen.getByText("arm64").tagName).toBe("DD");
  });

  it("renders the explicit fallback instead of a healthy-looking empty value", () => {
    render(
      <MockAppProvider>
        <DefinitionList>
          <DefinitionRow
            label="Release notes"
            value={null}
            emptyFallback="Not provided"
          />
        </DefinitionList>
      </MockAppProvider>,
    );

    expect(screen.getByText("Not provided").textContent).toBe("Not provided");
  });
});
