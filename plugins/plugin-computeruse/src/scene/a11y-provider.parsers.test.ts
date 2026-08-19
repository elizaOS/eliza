/**
 * Linux accessibility parser tests cover Hyprland and Sway window enumeration
 * for the scene grounding tier.
 *
 * Both parsers are pure adapters over `hyprctl clients -j` and
 * `swaymsg -t get_tree`, so fixture assertions can run on any CI host.
 * The Sway walk is also exercised against a 40k-deep nest that used to
 * stack-overflow after JSON.parse succeeded.
 */
import { describe, expect, it, vi } from "vitest";
import {
  MAX_SWAY_TREE_DEPTH,
  MAX_SWAY_TREE_VISIT,
  parseHyprlandClients,
  parseSwayTree,
} from "./a11y-provider.js";

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

  it("does not stack-overflow a 40k-deep nest after JSON.parse succeeds", () => {
    const leaf = '{"type":"con","app_id":"x","window":1}';
    const depth = 40_000;
    const json =
      '{"type":"root","nodes":['.repeat(depth) + leaf + "]}".repeat(depth);
    expect(() => JSON.parse(json)).not.toThrow();
    const started = performance.now();
    const out = parseSwayTree(json);
    expect(performance.now() - started).toBeLessThan(50);
    expect(out).toEqual([]);
  });

  it("stops walking after the visit budget instead of materializing every sibling", () => {
    const child = {
      type: "con",
      window: 1,
      app_id: "x",
      rect: { x: 0, y: 0, width: 1, height: 1 },
    };
    const json = JSON.stringify({
      type: "root",
      nodes: Array.from({ length: MAX_SWAY_TREE_VISIT + 500 }, () => child),
    });
    const out = parseSwayTree(json);
    expect(out.length).toBeLessThanOrEqual(MAX_SWAY_TREE_VISIT);
    expect(out.length).toBeGreaterThan(0);
  });

  it("does not inspect a wide child array beyond the work budget", () => {
    const child = { type: "con" };
    let reads = 0;
    const nodes = new Proxy(
      Array.from({ length: MAX_SWAY_TREE_VISIT + 500 }, () => child),
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property))
            reads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const parse = vi.spyOn(JSON, "parse").mockReturnValue({
      type: "root",
      nodes,
    });
    try {
      parseSwayTree("{}");
      expect(reads).toBeLessThan(MAX_SWAY_TREE_VISIT);
    } finally {
      parse.mockRestore();
    }
  });

  it("keeps depth-first order without preloading later root siblings", () => {
    const json = JSON.stringify({
      type: "root",
      nodes: [
        {
          type: "con",
          nodes: [
            {
              type: "con",
              window: 1,
              app_id: "first-subtree",
              rect: { x: 0, y: 0, width: 1, height: 1 },
            },
          ],
        },
        ...Array.from({ length: MAX_SWAY_TREE_VISIT + 500 }, () => ({
          type: "con",
        })),
      ],
    });
    expect(parseSwayTree(json).map((node) => node.label)).toContain(
      "first-subtree",
    );
  });

  it("does not recurse past the depth budget", () => {
    const json =
      '{"type":"root","nodes":['.repeat(MAX_SWAY_TREE_DEPTH + 8) +
      '{"type":"con","app_id":"deep","window":1}' +
      "]}".repeat(MAX_SWAY_TREE_DEPTH + 8);
    expect(parseSwayTree(json)).toEqual([]);
  });
});
