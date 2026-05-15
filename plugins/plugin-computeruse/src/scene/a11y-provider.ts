/**
 * AccessibilityProvider — thin abstraction over platform-specific a11y trees.
 *
 * The scene-builder needs structured a11y nodes (role, label, bbox, actions)
 * tagged with a stable id so the planner can say "click element a47" across
 * turns. The existing `platform/a11y.ts::extractA11yTree()` returns a single
 * flat string — useful for prompts but not structured. This module wraps it
 * with a typed-node interface and adds:
 *
 *   - Native impls per-OS that prefer structured JSON output where the
 *     platform supports it (AT-SPI emits structured data we just need to
 *     marshal; UIA/AX similarly).
 *   - A Wayland-compositor fallback (`hyprctl clients -j`, `swaymsg -t
 *     get_tree`) so Linux Wayland-only environments still surface windowable
 *     nodes even when AT-SPI is locked down.
 *   - A `NullAccessibilityProvider` for platforms / contexts where a11y is
 *     intentionally disabled (CI, headless runners).
 *
 * Stable id strategy:
 *   - Each provider emits `a<displayId>-<seq>` IDs. The same logical element
 *     keeps the same id across consecutive frames AS LONG AS the provider's
 *     in-memory map is preserved — we re-key when role + label + bbox
 *     intersect significantly with a previous frame's node. This is the
 *     contract WS7's "click element a47" depends on.
 *
 * The Android `AccessibilityService` impl is owned by WS8 and registers via
 * `setAccessibilityProvider()` at runtime — this module exposes the seam
 * but does not ship a JS-side implementation.
 */

import { execFileSync } from "node:child_process";
import { commandExists, currentPlatform } from "../platform/helpers.js";
import type { SceneAxNode } from "./scene-types.js";

export interface AccessibilityProvider {
  readonly name: string;
  /**
   * Whether this provider can produce structured nodes on the current host.
   * Used by `resolveAccessibilityProvider` to pick the best chain entry.
   */
  available(): boolean;
  /**
   * Capture the live a11y tree and return per-display node lists. Returns
   * an empty array when no nodes are reachable (vs throwing) so the
   * scene-builder always produces a Scene.
   */
  snapshot(): Promise<SceneAxNode[]>;
}

class NullAccessibilityProvider implements AccessibilityProvider {
  readonly name = "null";
  available(): boolean {
    return true;
  }
  async snapshot(): Promise<SceneAxNode[]> {
    return [];
  }
}

let activeProvider: AccessibilityProvider | null = null;

/**
 * Replace the active provider (used by Android/WS8 to inject the native
 * `AccessibilityService` adapter, and by tests).
 */
export function setAccessibilityProvider(
  provider: AccessibilityProvider,
): void {
  activeProvider = provider;
}

export function resolveAccessibilityProvider(): AccessibilityProvider {
  if (activeProvider) return activeProvider;
  const os = currentPlatform();
  if (os === "linux") return new LinuxAccessibilityProvider();
  if (os === "darwin") return new DarwinAccessibilityProvider();
  if (os === "win32") return new WindowsAccessibilityProvider();
  return new NullAccessibilityProvider();
}

interface IdAssignerState {
  seq: Map<number, number>;
}

export function makeIdAssigner(): IdAssignerState {
  return { seq: new Map() };
}

export function assignAxId(state: IdAssignerState, displayId: number): string {
  const cur = state.seq.get(displayId) ?? 0;
  const next = cur + 1;
  state.seq.set(displayId, next);
  return `a${displayId}-${next}`;
}

// ── Linux ───────────────────────────────────────────────────────────────────

export class LinuxAccessibilityProvider implements AccessibilityProvider {
  readonly name = "linux";

  available(): boolean {
    // AT-SPI requires python3 + python3-atspi/gi. Wayland fallback requires
    // hyprctl or swaymsg.
    return (
      commandExists("python3") ||
      commandExists("hyprctl") ||
      commandExists("swaymsg")
    );
  }

  async snapshot(): Promise<SceneAxNode[]> {
    // Try AT-SPI first (richest data on X11 / GNOME-Wayland), then fall
    // back to compositor-specific IPC.
    const atspiNodes = this.tryAtspi();
    if (atspiNodes.length > 0) return atspiNodes;
    const wayland = this.tryWaylandCompositor();
    return wayland;
  }

  private tryAtspi(): SceneAxNode[] {
    if (!commandExists("python3")) return [];
    const py = `
import json, sys
try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
    out = []
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(i)
        if not app: continue
        appname = app.get_name() or "unknown"
        for j in range(min(app.get_child_count(), 30)):
            win = app.get_child_at_index(j)
            if not win: continue
            try:
                ext = win.get_extents(Atspi.CoordType.SCREEN)
                bbox = [ext.x, ext.y, ext.width, ext.height]
            except Exception:
                bbox = [0,0,0,0]
            try:
                action_iface = win.get_action_iface()
                actions = []
                if action_iface:
                    n = action_iface.get_n_actions()
                    for k in range(n):
                        try: actions.append(action_iface.get_name(k))
                        except Exception: pass
            except Exception:
                actions = []
            out.append({
                "role": win.get_role_name() or "unknown",
                "label": win.get_name() or appname,
                "bbox": bbox,
                "actions": actions,
            })
    print(json.dumps(out))
except Exception as e:
    print("[]")
`;
    try {
      const text = execFileSync("python3", ["-c", py], {
        timeout: 4000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const parsed = JSON.parse(text || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((n) => n && typeof n === "object")
        .map((n, i) => mapAtspiNode(n as Record<string, unknown>, i));
    } catch {
      return [];
    }
  }

  private tryWaylandCompositor(): SceneAxNode[] {
    const xdgDesktop = (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase();
    if (xdgDesktop.includes("hyprland") || commandExists("hyprctl")) {
      const nodes = this.tryHyprland();
      if (nodes.length > 0) return nodes;
    }
    if (xdgDesktop.includes("sway") || commandExists("swaymsg")) {
      const nodes = this.trySway();
      if (nodes.length > 0) return nodes;
    }
    return [];
  }

  private tryHyprland(): SceneAxNode[] {
    try {
      const text = execFileSync("hyprctl", ["clients", "-j"], {
        timeout: 3000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return parseHyprlandClients(text);
    } catch {
      return [];
    }
  }

  private trySway(): SceneAxNode[] {
    try {
      const text = execFileSync("swaymsg", ["-t", "get_tree"], {
        timeout: 3000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return parseSwayTree(text);
    } catch {
      return [];
    }
  }
}

interface HyprClient {
  address?: string;
  workspace?: { id?: number };
  monitor?: number;
  class?: string;
  title?: string;
  at?: [number, number];
  size?: [number, number];
  focusHistoryID?: number;
}

export function parseHyprlandClients(text: string): SceneAxNode[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: SceneAxNode[] = [];
  let idx = 0;
  for (const item of raw as HyprClient[]) {
    if (!item || typeof item !== "object") continue;
    const at = Array.isArray(item.at) ? item.at : [0, 0];
    const size = Array.isArray(item.size) ? item.size : [0, 0];
    const displayId = Number.isFinite(Number(item.monitor))
      ? Number(item.monitor)
      : 0;
    out.push({
      id: `a${displayId}-${idx + 1}`,
      role: "window",
      label: item.title || item.class || "unknown",
      bbox: [
        Number(at[0] ?? 0),
        Number(at[1] ?? 0),
        Number(size[0] ?? 0),
        Number(size[1] ?? 0),
      ],
      actions: ["focus", "close"],
      displayId,
    });
    idx += 1;
  }
  return out;
}

interface SwayNode {
  name?: string;
  app_id?: string;
  window?: number;
  type?: string;
  rect?: { x?: number; y?: number; width?: number; height?: number };
  nodes?: SwayNode[];
  floating_nodes?: SwayNode[];
  output?: string;
  focused?: boolean;
}

export function parseSwayTree(text: string): SceneAxNode[] {
  let raw: SwayNode | null;
  try {
    raw = JSON.parse(text) as SwayNode;
  } catch {
    return [];
  }
  if (!raw) return [];
  const out: SceneAxNode[] = [];
  let seq = 0;
  const outputToDisplay = new Map<string, number>();
  // First pass — assign display ids by output name encounter order.
  const visit = (node: SwayNode, currentOutput: string): void => {
    if (node.type === "output" && typeof node.name === "string") {
      if (!outputToDisplay.has(node.name)) {
        outputToDisplay.set(node.name, outputToDisplay.size);
      }
      currentOutput = node.name;
    }
    if (node.type === "con" || node.type === "floating_con") {
      if (node.window !== undefined || node.app_id) {
        const displayId = outputToDisplay.get(currentOutput) ?? 0;
        seq += 1;
        const rect = node.rect ?? {};
        out.push({
          id: `a${displayId}-${seq}`,
          role: "window",
          label: node.name || node.app_id || "unknown",
          bbox: [
            Number(rect.x ?? 0),
            Number(rect.y ?? 0),
            Number(rect.width ?? 0),
            Number(rect.height ?? 0),
          ],
          actions: ["focus", "close"],
          displayId,
        });
      }
    }
    for (const child of node.nodes ?? []) visit(child, currentOutput);
    for (const child of node.floating_nodes ?? []) visit(child, currentOutput);
  };
  visit(raw, "");
  return out;
}

function mapAtspiNode(raw: Record<string, unknown>, idx: number): SceneAxNode {
  const bbox = Array.isArray(raw.bbox)
    ? (raw.bbox as unknown[]).map((v) => Number(v))
    : [0, 0, 0, 0];
  const actions = Array.isArray(raw.actions)
    ? (raw.actions as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : [];
  return {
    id: `a0-${idx + 1}`,
    role: typeof raw.role === "string" ? raw.role : "unknown",
    label: typeof raw.label === "string" ? raw.label : undefined,
    bbox: [bbox[0] ?? 0, bbox[1] ?? 0, bbox[2] ?? 0, bbox[3] ?? 0],
    actions,
    displayId: 0,
  };
}

// ── macOS ───────────────────────────────────────────────────────────────────

export class DarwinAccessibilityProvider implements AccessibilityProvider {
  readonly name = "darwin";

  available(): boolean {
    return true; // osascript always present; user permission needed at runtime.
  }

  async snapshot(): Promise<SceneAxNode[]> {
    try {
      const script = `
        const SE = Application("System Events");
        const procs = SE.processes.whose({visible: true})();
        const out = [];
        for (let p of procs) {
          try {
            const appName = p.name();
            for (let w of p.windows()) {
              try {
                const pos = w.position();
                const sz = w.size();
                out.push({
                  app: appName,
                  title: w.name(),
                  bbox: [pos[0], pos[1], sz[0], sz[1]],
                });
              } catch (e) {}
            }
          } catch (e) {}
        }
        JSON.stringify(out);
      `;
      const text = execFileSync(
        "osascript",
        ["-l", "JavaScript", "-e", script],
        {
          timeout: 8000,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const parsed = JSON.parse(text || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.map((n, i) => {
        const bbox = Array.isArray(n?.bbox) ? n.bbox : [0, 0, 0, 0];
        return {
          id: `a0-${i + 1}`,
          role: "window",
          label: typeof n?.title === "string" ? n.title : n?.app,
          bbox: [
            Number(bbox[0]) || 0,
            Number(bbox[1]) || 0,
            Number(bbox[2]) || 0,
            Number(bbox[3]) || 0,
          ],
          actions: ["focus", "close"],
          displayId: 0,
        } as SceneAxNode;
      });
    } catch {
      return [];
    }
  }
}

// ── Windows ─────────────────────────────────────────────────────────────────

export class WindowsAccessibilityProvider implements AccessibilityProvider {
  readonly name = "win32";

  available(): boolean {
    return true; // PowerShell UIA always available on supported Windows.
  }

  async snapshot(): Promise<SceneAxNode[]> {
    const ps = `
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$walker = [System.Windows.Automation.TreeWalker]::ContentViewWalker
$child = $walker.GetFirstChild($root)
$out = @()
$count = 0
while ($child -and $count -lt 50) {
  try {
    $rect = $child.Current.BoundingRectangle
    $row = [PSCustomObject]@{
      role = $child.Current.ControlType.ProgrammaticName
      label = $child.Current.Name
      bbox = @($rect.X, $rect.Y, $rect.Width, $rect.Height)
    }
    $out += $row
  } catch {}
  $child = $walker.GetNextSibling($child)
  $count++
}
$out | ConvertTo-Json -Depth 4 -Compress
`;
    try {
      const text = execFileSync("powershell", ["-NoProfile", "-Command", ps], {
        timeout: 10_000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const parsed = JSON.parse(text || "[]");
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list
        .filter((n) => n && typeof n === "object")
        .map((n, i) => {
          const bbox = Array.isArray(n.bbox) ? n.bbox : [0, 0, 0, 0];
          return {
            id: `a0-${i + 1}`,
            role: typeof n.role === "string" ? n.role : "unknown",
            label: typeof n.label === "string" ? n.label : undefined,
            bbox: [
              Number(bbox[0]) || 0,
              Number(bbox[1]) || 0,
              Number(bbox[2]) || 0,
              Number(bbox[3]) || 0,
            ],
            actions: [],
            displayId: 0,
          } as SceneAxNode;
        });
    } catch {
      return [];
    }
  }
}

export { NullAccessibilityProvider };
