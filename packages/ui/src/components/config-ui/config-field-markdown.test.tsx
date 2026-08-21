/** Verifies plugin-config markdown preview link sanitizing through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Regression coverage for the plugin-config markdown field preview: a markdown
 * link URL is a plugin/agent-supplied value rendered into `<a href>`, so any
 * URL outside the attachment scheme allowlist must degrade to plain text
 * instead of becoming a clickable link. jsdom render with a mocked app store;
 * no network.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock("../../state", () => ({
  useAppSelector: (sel: (value: Record<string, unknown>) => unknown) =>
    sel(appMock.value),
}));

import type { FieldRenderProps } from "../../config/config-catalog";
import { renderMarkdownField } from "./config-field.helpers";

// FieldRenderProps carries a required `key`, and the field renderers spread
// those props into JSX — React logs a dev-mode key-spread warning on that
// pre-existing pattern. Swallow exactly that warning so the harness's
// unexpected-console gate still catches anything new from these tests.
const KEY_SPREAD_WARNING =
  'A props object containing a "key" prop is being spread into JSX';

beforeEach(() => {
  const recorder = console.error;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes(KEY_SPREAD_WARNING)) {
      return;
    }
    recorder(...args);
  });
});

function t(key: string, options?: { defaultValue?: string }) {
  return options?.defaultValue ?? key;
}

function propsFor(value: string): FieldRenderProps {
  return {
    key: "NOTES",
    value,
    schema: { type: "string" },
    hint: { label: "Notes" },
    fieldType: "markdown",
    onChange: () => {},
    isSet: true,
    required: false,
    errors: [],
    readonly: false,
  };
}

function renderPreview(value: string) {
  appMock.value = { t };
  const Renderer = renderMarkdownField;
  render(<Renderer {...propsFor(value)} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("markdown field preview link sanitizing", () => {
  it("renders an http(s) link as an anchor", () => {
    renderPreview("See [docs](https://example.com/docs) now");
    const link = screen.getByRole("link", { name: "docs" });
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("renders a root-relative link as an anchor", () => {
    renderPreview("Open [settings](/apps/files)");
    expect(
      screen.getByRole("link", { name: "settings" }).getAttribute("href"),
    ).toBe("/apps/files");
  });

  it("degrades a javascript: link to plain text", () => {
    renderPreview("[click](javascript:alert(1))");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("degrades a data:text/html link to plain text", () => {
    renderPreview("[click](data:text/html,<b>hi</b>)");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("degrades an arbitrary custom-scheme link to plain text", () => {
    renderPreview("[click](foo://launch-os-handler)");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
