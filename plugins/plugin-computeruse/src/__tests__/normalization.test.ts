import { describe, expect, it } from "vitest";
import { normalizeComputerUseParams } from "../normalization.js";

describe("normalizeComputerUseParams", () => {
  it("clones input and leaves canonical fields intact", () => {
    const input = {
      path: "/canonical.txt",
      filepath: "/alias.txt",
      coordinate: [7, 8],
      x: 1,
      y: 2,
    };

    const normalized = normalizeComputerUseParams("file_write", input);

    expect(normalized).not.toBe(input);
    expect(normalized.path).toBe("/canonical.txt");
    expect(normalized.coordinate).toEqual([7, 8]);
    expect(input).toEqual({
      path: "/canonical.txt",
      filepath: "/alias.txt",
      coordinate: [7, 8],
      x: 1,
      y: 2,
    });
  });

  it("normalizes filepath and dirpath to path", () => {
    expect(
      normalizeComputerUseParams("file_read", { filepath: "/tmp/a.txt" }).path,
    ).toBe("/tmp/a.txt");
    expect(
      normalizeComputerUseParams("directory_list", { dirpath: "/tmp" }).path,
    ).toBe("/tmp");
  });

  it("normalizes find and replace to old_text and new_text", () => {
    const normalized = normalizeComputerUseParams("file_edit", {
      find: "old text",
      replace: "new text",
    });

    expect(normalized.old_text).toBe("old text");
    expect(normalized.new_text).toBe("new text");
  });

  it("normalizes tab_index to index and tabId", () => {
    const switchTab = normalizeComputerUseParams("browser_switch_tab", {
      tab_index: 4,
    });

    expect(switchTab.index).toBe(4);
    expect(switchTab.tabId).toBe("4");

    const closeTab = normalizeComputerUseParams("close_tab", {
      tab_index: "11",
    });

    expect(closeTab.index).toBe(11);
    expect(closeTab.tabId).toBe("11");
  });

  it("normalizes x/y aliases into coordinate tuples", () => {
    const normalized = normalizeComputerUseParams("click", {
      x: "12",
      y: 34,
    });

    expect(normalized.coordinate).toEqual([12, 34]);
  });

  it("normalizes direct coordinate arrays and objects", () => {
    expect(
      normalizeComputerUseParams("mouse_move", {
        coordinate: ["9", "10"],
      }).coordinate,
    ).toEqual([9, 10]);

    expect(
      normalizeComputerUseParams("scroll", {
        coordinate: { x: 15, y: 16 },
      }).coordinate,
    ).toEqual([15, 16]);
  });

  it("normalizes drag start and end aliases", () => {
    const normalized = normalizeComputerUseParams("drag", {
      x1: "1",
      y1: 2,
      x2: 3,
      y2: "4",
    });

    expect(normalized.startCoordinate).toEqual([1, 2]);
    expect(normalized.coordinate).toEqual([3, 4]);
  });

  it("normalizes alternate start and end coordinate names", () => {
    const normalized = normalizeComputerUseParams("drag", {
      startX: 5,
      startY: 6,
      endX: 7,
      endY: 8,
    });

    expect(normalized.startCoordinate).toEqual([5, 6]);
    expect(normalized.coordinate).toEqual([7, 8]);
  });

  it("normalizes underscore coordinate aliases", () => {
    const normalized = normalizeComputerUseParams("drag", {
      start_coordinate: [1, 2],
      end_coordinate: [3, 4],
    });

    expect(normalized.startCoordinate).toEqual([1, 2]);
    expect(normalized.coordinate).toEqual([3, 4]);
  });

  it("normalizes window identifiers from title aliases", () => {
    expect(
      normalizeComputerUseParams("switch_to_window", {
        title: "Terminal",
      }).windowId,
    ).toBe("Terminal");

    expect(
      normalizeComputerUseParams("switch_to_window", {
        window: "Finder",
      }).windowId,
    ).toBe("Finder");
  });

  it("preserves unrelated fields", () => {
    const normalized = normalizeComputerUseParams("browser_open", {
      url: "https://example.com",
      extra: true,
    });

    expect(normalized.url).toBe("https://example.com");
    expect(normalized.extra).toBe(true);
  });

  it("treats null and undefined input as empty params", () => {
    expect(normalizeComputerUseParams("click", null)).toEqual({});
    expect(normalizeComputerUseParams("click", undefined)).toEqual({});
  });
});
