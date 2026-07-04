/**
 * Linux accessibility parser tests cover Hyprland and Sway window enumeration
 * for the scene grounding tier.
 *
 * Both parsers are pure adapters over `hyprctl clients -j` and
 * `swaymsg -t get_tree`, so fixture assertions can run on any CI host.
 */
import { describe, expect, it } from "vitest";
import { parseHyprlandClients, parseSwayTree } from "./a11y-provider.js";

describe("parseHyprlandClients", () => {
  it("maps each client to a window node with display-absolute bbox", () => {
    const out = parseHyprlandClients(
      JSON.stringify([
        {
          title: "Firefox",
          class: "firefox",
          at: [10, 20],
          size: [800, 600],
          monitor: 0,
        },
        {
          title: "",
          class: "kitty",
          at: [100, 50],
          size: [640, 480],
          monitor: 1,
        },
      ]),
    );
    expect(out).toEqual([
      {
        id: "a0-1",
        role: "window",
        label: "Firefox",
        bbox: [10, 20, 800, 600],
        actions: ["focus", "close"],
        displayId: 0,
      },
      {
        id: "a1-2",
        role: "window",
        label: "kitty", // empty title falls back to class
        bbox: [100, 50, 640, 480],
        actions: ["focus", "close"],
        displayId: 1,
      },
    ]);
  });

  it("falls back to 'unknown' when neither title nor class is present", () => {
    const [w] = parseHyprlandClients(
      JSON.stringify([{ at: [0, 0], size: [0, 0], monitor: 0 }]),
    );
    expect(w.label).toBe("unknown");
  });

  it("skips malformed entries without consuming an index", () => {
    const out = parseHyprlandClients(
      JSON.stringify([
        null,
        { title: "X", at: [1, 2], size: [3, 4], monitor: 0 },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("a0-1"); // index not advanced by the skipped null
  });

  it("returns [] on invalid JSON or a non-array payload", () => {
    expect(parseHyprlandClients("not json")).toEqual([]);
    expect(parseHyprlandClients(JSON.stringify({ a: 1 }))).toEqual([]);
  });
});

describe("parseSwayTree", () => {
  it("assigns display ids by output encounter order and emits only real windows", () => {
    const out = parseSwayTree(
      JSON.stringify({
        type: "root",
        nodes: [
          {
            type: "output",
            name: "eDP-1",
            nodes: [
              // a bare workspace container (no window/app_id) is traversed, not emitted
              {
                type: "con",
                nodes: [
                  {
                    type: "con",
                    window: 123,
                    name: "Term",
                    rect: { x: 0, y: 0, width: 1920, height: 1080 },
                  },
                ],
              },
            ],
          },
          {
            type: "output",
            name: "HDMI-1",
            nodes: [
              {
                type: "con",
                app_id: "firefox",
                rect: { x: 1920, y: 0, width: 1280, height: 720 },
              },
            ],
            floating_nodes: [
              {
                type: "floating_con",
                window: 9,
                name: "Float",
                rect: { x: 1930, y: 10, width: 50, height: 60 },
              },
            ],
          },
        ],
      }),
    );
    expect(out).toEqual([
      {
        id: "a0-1",
        role: "window",
        label: "Term",
        bbox: [0, 0, 1920, 1080],
        actions: ["focus", "close"],
        displayId: 0,
      },
      {
        id: "a1-2",
        role: "window",
        label: "firefox", // no name → app_id
        bbox: [1920, 0, 1280, 720],
        actions: ["focus", "close"],
        displayId: 1,
      },
      {
        id: "a1-3",
        role: "window",
        label: "Float",
        bbox: [1930, 10, 50, 60],
        actions: ["focus", "close"],
        displayId: 1,
      },
    ]);
  });

  it("returns [] on invalid JSON or a null tree", () => {
    expect(parseSwayTree("{bad")).toEqual([]);
    expect(parseSwayTree("null")).toEqual([]);
  });
});
