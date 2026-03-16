// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CloudConnectionStatus,
  CloudSourceModeToggle,
  ConfigSaveFooter,
} from "@elizaos/app-core/components";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => ({
    t: (key: string) => key,
  }),
}));

function blockFor(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? "";
}

const animeCssPath = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "app-core",
  "src",
  "styles",
  "anime.css",
);

const stylesCssPath = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "app-core",
  "src",
  "styles",
  "styles.css",
);

describe("settings control styles", () => {
  it("renders the cloud source toggle as a rounded segmented control", async () => {
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <CloudSourceModeToggle mode="cloud" onChange={() => {}} />,
      );
    });

    const root = tree.root;
    const container = root.findByType("div");
    const buttons = root.findAllByType("button");

    expect(container.props.className).toContain("rounded-lg");
    expect(buttons).toHaveLength(2);
    expect(buttons[0].props.className).toContain("first:rounded-l-lg");
    expect(buttons[0].props.className).toContain("first:rounded-r-none");
    expect(buttons[1].props.className).toContain("last:rounded-r-lg");
    expect(buttons[1].props.className).toContain("last:rounded-l-none");
  });

  it("keeps settings status badges readable instead of yellow text", async () => {
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <CloudConnectionStatus connected={false} disconnectedText="Offline" />,
      );
    });

    const badge = tree.root
      .findAllByType("span")
      .find((node) => node.props.className?.includes("rounded-full"));

    expect(badge).toBeDefined();
    expect(badge?.props.className).toContain("text-[var(--text)]");
    expect(badge?.props.className).not.toMatch(/yellow/);
  });

  it("uses the shared rounded button in config save footers", async () => {
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <ConfigSaveFooter
          dirty
          saving={false}
          saveError={null}
          saveSuccess={false}
          onSave={() => {}}
        />,
      );
    });

    const button = tree.root.findByType("button");
    expect(button.props.className).toContain("rounded-lg");
  });

  it("keeps settings accent foreground text mapped to the actual foreground", () => {
    const css = readFileSync(animeCssPath, "utf8");

    const accentForegroundBlock = blockFor(
      css,
      ".settings-content-area .text-\\[var\\(--accent-foreground\\)\\]",
    );
    const gridButtonBlock = blockFor(
      css,
      '.settings-content-area .grid button[class*="border"][class*="cursor-pointer"]',
    );

    expect(accentForegroundBlock).toContain("color: var(--accent-foreground);");
    expect(gridButtonBlock).toContain("border-radius: var(--radius-lg);");
    expect(gridButtonBlock).not.toContain("clip-path");
  });

  it("uses a dark accent foreground for yellow settings buttons", () => {
    const css = readFileSync(animeCssPath, "utf8");

    expect(css).toContain("--accent-foreground: #1a1f26;");
  });

  it("applies shared padding rules to settings page buttons and cards", () => {
    const css = readFileSync(stylesCssPath, "utf8");

    expect(css).toContain(".settings-scroll-region");
    expect(css).toContain("scroll-padding-top: 7rem;");
    expect(css).toContain(".settings-page-content");
    expect(css).toContain(":is(button.inline-flex, a.inline-flex, .btn):not(");
    expect(css).toContain(".settings-compact-button");
    expect(css).toContain(".settings-icon-button");
    expect(css).toContain("min-height: 2.625rem;");
    expect(css).toContain(".settings-card-button");
    expect(css).toContain("min-height: 5.5rem;");
  });
});
