// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewEntry } from "../../hooks/view-catalog";
import { SPRINGBOARD_STORAGE_KEY } from "../../state/springboard-layout";
import { Springboard } from "./Springboard";

function entry(id: string, label: string): ViewEntry {
  return {
    key: `view:${id}`,
    id,
    label,
    icon: "LayoutGrid",
    hasHero: false,
    modality: "gui",
    state: "loaded",
    kind: "view",
    viewKind: "release",
  } as ViewEntry;
}

const FEW = [entry("chat", "Chat"), entry("settings", "Settings")];

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe("Springboard", () => {
  it("renders every view as a names-only icon tile", () => {
    render(<Springboard entries={FEW} onLaunch={() => {}} />);
    expect(screen.getByTestId("springboard-tile-chat")).toBeTruthy();
    expect(screen.getByTestId("springboard-tile-settings")).toBeTruthy();
    // Label text is present (names below icons), no descriptions.
    expect(screen.getByText("Chat")).toBeTruthy();
  });

  it("launches a view on tap (not in edit mode)", () => {
    const onLaunch = vi.fn();
    render(<Springboard entries={FEW} onLaunch={onLaunch} />);
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch.mock.calls[0][0].id).toBe("chat");
  });

  it("does not launch while editing", () => {
    const onLaunch = vi.fn();
    render(<Springboard entries={FEW} onLaunch={onLaunch} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("favorites a view into the dock and persists the layout", () => {
    // `notes` is not in DEFAULT_SPRINGBOARD_FAVORITES (#9144), so favoriting it
    // genuinely adds it to the dock rather than toggling off a pre-seeded id.
    const entries = [entry("notes", "Notes"), entry("settings", "Settings")];
    render(<Springboard entries={entries} onLaunch={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByTestId("springboard-fav-notes"));
    // The dock now contains a Notes tile (keyed dock-notes).
    expect(screen.getByTestId("springboard-tile-notes")).toBeTruthy();
    const stored = JSON.parse(
      window.localStorage.getItem(SPRINGBOARD_STORAGE_KEY) ?? "{}",
    );
    expect(stored.favorites).toContain("notes");
  });

  it("shows page dots when there is more than one page", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      entry(`v${i}`, `View ${i}`),
    );
    render(<Springboard entries={many} onLaunch={() => {}} />);
    expect(screen.getByRole("button", { name: "Page 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Page 2" })).toBeTruthy();
  });

  it("navigates pages via the page dots", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      entry(`v${i}`, `View ${i}`),
    );
    render(<Springboard entries={many} onLaunch={() => {}} />);
    // Page 1 shows the first page's views, not the 21st.
    expect(screen.queryByTestId("springboard-tile-v20")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Page 2" }));
    expect(screen.getByTestId("springboard-tile-v20")).toBeTruthy();
  });

  it("drops views that are no longer available on re-render", () => {
    const { rerender } = render(
      <Springboard entries={FEW} onLaunch={() => {}} />,
    );
    expect(screen.getByTestId("springboard-tile-settings")).toBeTruthy();
    rerender(
      <Springboard entries={[entry("chat", "Chat")]} onLaunch={() => {}} />,
    );
    expect(screen.queryByTestId("springboard-tile-settings")).toBeNull();
  });
});

// Keep `within` referenced for future grouped-dock assertions without lint noise.
void within;
