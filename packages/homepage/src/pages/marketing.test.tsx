// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import Marketing from "./marketing";

describe("Marketing", () => {
  it("shows Cloud and download entry points on the landing page", () => {
    render(
      <MemoryRouter>
        <Marketing />
      </MemoryRouter>,
    );

    const cloudLink = screen.getByRole("link", {
      name: "Open in Cloud",
    }) as HTMLAnchorElement;
    const downloadLink = screen.getByRole("link", {
      name: "Download",
    }) as HTMLAnchorElement;

    expect(cloudLink.href).toBe("https://www.elizacloud.ai/");
    expect(downloadLink.getAttribute("href")).toBe("#download");
    expect(screen.getByRole("heading", { name: "Download" })).toBeTruthy();
  });
});
