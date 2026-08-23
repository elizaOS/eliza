/**
 * macOS Accessibility-first control.
 *
 * A snapshot is scoped to one exact running application and yields opaque
 * element references that are valid only for that snapshot. Consequential
 * actions consume the snapshot, re-resolve the native AX path, and verify the
 * element fingerprint before acting. This keeps normal button presses, value
 * writes, focus, window raise, and AX scrolling off the physical mouse path.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type MacosAccessibilityAction =
  | "press"
  | "confirm"
  | "raise"
  | "focus"
  | "set_value"
  | "scroll_up"
  | "scroll_down"
  | "scroll_left"
  | "scroll_right";

export interface MacosAccessibilityElement {
  id: string;
  app: string;
  pid: number;
  role: string;
  subrole?: string;
  label?: string;
  bbox: [number, number, number, number];
  actions: string[];
}

export interface MacosAccessibilitySnapshot {
  snapshotId: string;
  app: string;
  pid: number;
  observedAt: string;
  expiresAt: string;
  elements: MacosAccessibilityElement[];
}

export interface MacosAccessibilityActionInput {
  snapshotId: string;
  elementId: string;
  app: string;
  action: MacosAccessibilityAction;
  text?: string;
}

export interface CursorPoint {
  x: number;
  y: number;
}

export interface MacosAccessibilityControllerDeps {
  runNative?: (request: Record<string, unknown>) => string;
  now?: () => number;
  idFactory?: () => string;
  readCursor?: () => Promise<CursorPoint>;
  ttlMs?: number;
  maxSnapshots?: number;
}

interface NativeElement {
  path: number[];
  role: string;
  subrole?: string;
  label?: string;
  bbox: [number, number, number, number];
  actions: string[];
  fingerprint: string;
}

interface NativeSnapshotPayload {
  app: string;
  pid: number;
  elements: NativeElement[];
}

interface StoredElement extends MacosAccessibilityElement {
  path: number[];
  fingerprint: string;
}

interface StoredSnapshot {
  publicSnapshot: MacosAccessibilitySnapshot;
  elements: Map<string, StoredElement>;
  expiresAtMs: number;
}

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_MAX_SNAPSHOTS = 4;
const MAX_PUBLIC_AX_ELEMENTS = 250;
const INTERACTIVE_AX_ROLES = new Set([
  "AXButton",
  "AXCell",
  "AXCheckBox",
  "AXComboBox",
  "AXDisclosureTriangle",
  "AXLink",
  "AXMenuItem",
  "AXOutline",
  "AXPopUpButton",
  "AXRadioButton",
  "AXRow",
  "AXScrollArea",
  "AXSearchField",
  "AXSlider",
  "AXTabGroup",
  "AXTable",
  "AXTextArea",
  "AXTextField",
  "AXWindow",
]);

const SWIFT_PROGRAM = String.raw`
import AppKit
import ApplicationServices
import Foundation

enum AXControlError: Error, CustomStringConvertible {
  case named(String)
  var description: String {
    switch self { case .named(let value): return value }
  }
}

func fail(_ name: String) throws -> Never { throw AXControlError.named(name) }

func copyAttribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}

func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String {
  return copyAttribute(element, name) as? String ?? ""
}

func elementsAttribute(_ element: AXUIElement, _ name: CFString) -> [AXUIElement] {
  return copyAttribute(element, name) as? [AXUIElement] ?? []
}

func pointAttribute(_ element: AXUIElement, _ name: CFString) -> CGPoint {
  guard let value = copyAttribute(element, name) else { return .zero }
  var point = CGPoint.zero
  guard CFGetTypeID(value) == AXValueGetTypeID(),
        AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return .zero }
  return point
}

func sizeAttribute(_ element: AXUIElement, _ name: CFString) -> CGSize {
  guard let value = copyAttribute(element, name) else { return .zero }
  var size = CGSize.zero
  guard CFGetTypeID(value) == AXValueGetTypeID(),
        AXValueGetValue(value as! AXValue, .cgSize, &size) else { return .zero }
  return size
}

func actionNames(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
  return names as? [String] ?? []
}

func jsonString(_ value: Any) -> String {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return "" }
  return String(data: data, encoding: .utf8) ?? ""
}

func describe(_ element: AXUIElement, path: [Int]) -> [String: Any] {
  let role = stringAttribute(element, kAXRoleAttribute as CFString)
  let subrole = stringAttribute(element, kAXSubroleAttribute as CFString)
  let title = stringAttribute(element, kAXTitleAttribute as CFString)
  let description = stringAttribute(element, kAXDescriptionAttribute as CFString)
  let identifier = stringAttribute(element, kAXIdentifierAttribute as CFString)
  let position = pointAttribute(element, kAXPositionAttribute as CFString)
  let size = sizeAttribute(element, kAXSizeAttribute as CFString)
  let bbox: [Double] = [position.x, position.y, size.width, size.height]
  let fingerprint = jsonString([role, subrole, title.isEmpty ? description : title, identifier, bbox])
  return [
    "path": path,
    "role": role.isEmpty ? "AXUnknown" : role,
    "subrole": subrole,
    "label": title.isEmpty ? description : title,
    "bbox": bbox,
    "actions": actionNames(element),
    "fingerprint": fingerprint,
  ]
}

func resolveElement(_ appElement: AXUIElement, path: [Int]) throws -> AXUIElement {
  let windows = elementsAttribute(appElement, kAXWindowsAttribute as CFString)
  guard let first = path.first, first >= 0, first < windows.count else { try fail("AX_ELEMENT_GONE") }
  var element = windows[first]
  for index in path.dropFirst() {
    let children = elementsAttribute(element, kAXChildrenAttribute as CFString)
    guard index >= 0, index < children.count else { try fail("AX_ELEMENT_GONE") }
    element = children[index]
  }
  return element
}

func perform(_ element: AXUIElement, _ action: CFString) throws {
  guard AXUIElementPerformAction(element, action) == .success else { try fail("AX_ACTION_UNSUPPORTED") }
}

do {
  let input = FileHandle.standardInput.readDataToEndOfFile()
  guard let request = try JSONSerialization.jsonObject(with: input) as? [String: Any],
        let appName = request["app"] as? String else { try fail("AX_INVALID_REQUEST") }
  let matches = NSWorkspace.shared.runningApplications.filter {
    !$0.isTerminated && $0.localizedName == appName
  }
  guard matches.count == 1, let running = matches.first else {
    try fail(matches.isEmpty ? "AX_APP_NOT_FOUND" : "AX_APP_TARGET_AMBIGUOUS")
  }
  let pid = Int(running.processIdentifier)
  let appElement = AXUIElementCreateApplication(running.processIdentifier)

  if request["kind"] as? String == "snapshot" {
    let windows = elementsAttribute(appElement, kAXWindowsAttribute as CFString)
    var queue: [(AXUIElement, [Int], Int)] = windows.enumerated().map { ($0.element, [$0.offset], 0) }
    var cursor = 0
    var output: [[String: Any]] = []
    while cursor < queue.count && output.count < 500 {
      let current = queue[cursor]
      cursor += 1
      output.append(describe(current.0, path: current.1))
      if current.2 >= 12 { continue }
      let children = elementsAttribute(current.0, kAXChildrenAttribute as CFString)
      for (index, child) in children.enumerated() where output.count + queue.count - cursor < 500 {
        queue.append((child, current.1 + [index], current.2 + 1))
      }
    }
    let result: [String: Any] = ["app": appName, "pid": pid, "elements": output]
    let data = try JSONSerialization.data(withJSONObject: result)
    FileHandle.standardOutput.write(data)
    exit(0)
  }

  guard request["kind"] as? String == "action",
        request["pid"] as? Int == pid,
        let path = request["path"] as? [Int],
        let expectedFingerprint = request["fingerprint"] as? String,
        let action = request["action"] as? String else { try fail("AX_APP_GENERATION_CHANGED") }
  let element = try resolveElement(appElement, path: path)
  guard describe(element, path: path)["fingerprint"] as? String == expectedFingerprint else {
    try fail("AX_STALE_ELEMENT")
  }
  switch action {
  case "press": try perform(element, kAXPressAction as CFString)
  case "confirm": try perform(element, "AXConfirm" as CFString)
  case "raise":
    running.activate()
    try perform(element, kAXRaiseAction as CFString)
  case "focus":
    running.activate()
    guard AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
      try fail("AX_ACTION_UNSUPPORTED")
    }
  case "set_value":
    guard let text = request["text"] as? String else { try fail("AX_VALUE_REQUIRED") }
    guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef) == .success else {
      try fail("AX_ACTION_UNSUPPORTED")
    }
  case "scroll_up": try perform(element, "AXScrollUp" as CFString)
  case "scroll_down": try perform(element, "AXScrollDown" as CFString)
  case "scroll_left": try perform(element, "AXScrollLeft" as CFString)
  case "scroll_right": try perform(element, "AXScrollRight" as CFString)
  default: try fail("AX_UNKNOWN_ACTION")
  }
  FileHandle.standardOutput.write(Data("{\"ok\":true}".utf8))
} catch {
  FileHandle.standardError.write(Data(String(describing: error).utf8))
  exit(2)
}
`;

function defaultRunNative(request: Record<string, unknown>): string {
  const packagedHelper = fileURLToPath(
    new URL("../native/macos/accessibility-control", import.meta.url),
  );
  const sourceHelper = fileURLToPath(
    new URL("../../native/macos/accessibility-control", import.meta.url),
  );
  const helperPath = [packagedHelper, sourceHelper].find((candidate) =>
    existsSync(candidate),
  );
  if (helperPath) {
    return execFileSync(helperPath, [], {
      timeout: 8_000,
      encoding: "utf8",
      input: JSON.stringify(request),
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  // Source-only development fallback. Packaged Darwin builds fail their build
  // gate unless the compiled helper is present, executable, and target-arch.
  return execFileSync("/usr/bin/swift", ["-e", SWIFT_PROGRAM], {
    timeout: 8_000,
    encoding: "utf8",
    input: JSON.stringify(request),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function cursorChanged(before: CursorPoint, after: CursorPoint): boolean {
  return Math.abs(before.x - after.x) > 1 || Math.abs(before.y - after.y) > 1;
}

function boundedPositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : fallback;
}

export class MacosAccessibilityController {
  private readonly runNative: (request: Record<string, unknown>) => string;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly readCursor?: () => Promise<CursorPoint>;
  private readonly ttlMs: number;
  private readonly maxSnapshots: number;
  private readonly snapshots = new Map<string, StoredSnapshot>();
  private readonly latestSnapshotByApp = new Map<string, string>();

  constructor(deps: MacosAccessibilityControllerDeps = {}) {
    this.runNative = deps.runNative ?? defaultRunNative;
    this.now = deps.now ?? Date.now;
    this.idFactory = deps.idFactory ?? randomUUID;
    this.readCursor = deps.readCursor;
    this.ttlMs = boundedPositive(deps.ttlMs, DEFAULT_TTL_MS);
    this.maxSnapshots = boundedPositive(
      deps.maxSnapshots,
      DEFAULT_MAX_SNAPSHOTS,
    );
  }

  snapshot(app: string): MacosAccessibilitySnapshot {
    const scopedApp = app.trim();
    if (!scopedApp)
      throw new Error("app is required for accessibility_snapshot");
    this.prune();
    const raw = this.runNative({ kind: "snapshot", app: scopedApp });
    const parsed = JSON.parse(raw) as NativeSnapshotPayload;
    if (
      parsed.app !== scopedApp ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      !Array.isArray(parsed.elements)
    ) {
      throw new Error("Invalid macOS Accessibility snapshot payload");
    }
    const snapshotId = `axs_${this.idFactory()}`;
    const observedAtMs = this.now();
    const expiresAtMs = observedAtMs + this.ttlMs;
    const storedElements = new Map<string, StoredElement>();
    const publicElements = parsed.elements
      .filter(
        (native) =>
          native.actions.length > 0 || INTERACTIVE_AX_ROLES.has(native.role),
      )
      .slice(0, MAX_PUBLIC_AX_ELEMENTS)
      .map((native, index) => {
        const id = `${snapshotId}_e${index + 1}`;
        const element: StoredElement = {
          id,
          app: scopedApp,
          pid: parsed.pid,
          role: native.role,
          ...(native.subrole ? { subrole: native.subrole } : {}),
          ...(native.label ? { label: native.label } : {}),
          bbox: native.bbox,
          actions: native.actions,
          path: native.path,
          fingerprint: native.fingerprint,
        };
        storedElements.set(id, element);
        const {
          path: _path,
          fingerprint: _fingerprint,
          ...publicElement
        } = element;
        return publicElement;
      });
    const publicSnapshot: MacosAccessibilitySnapshot = {
      snapshotId,
      app: scopedApp,
      pid: parsed.pid,
      observedAt: new Date(observedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      elements: publicElements,
    };
    this.snapshots.set(snapshotId, {
      publicSnapshot,
      elements: storedElements,
      expiresAtMs,
    });
    const previous = this.latestSnapshotByApp.get(scopedApp);
    if (previous && previous !== snapshotId) this.snapshots.delete(previous);
    this.latestSnapshotByApp.set(scopedApp, snapshotId);
    this.prune();
    return publicSnapshot;
  }

  async act(input: MacosAccessibilityActionInput): Promise<void> {
    this.prune();
    const stored = this.snapshots.get(input.snapshotId);
    if (!stored) throw new Error("AX_STALE_SNAPSHOT");
    if (stored.publicSnapshot.app !== input.app)
      throw new Error("AX_APP_SCOPE_MISMATCH");
    if (this.latestSnapshotByApp.get(input.app) !== input.snapshotId) {
      throw new Error("AX_STALE_SNAPSHOT");
    }
    const element = stored.elements.get(input.elementId);
    if (!element) throw new Error("AX_ELEMENT_NOT_IN_SNAPSHOT");
    if (element.app !== input.app) throw new Error("AX_APP_SCOPE_MISMATCH");

    const before = this.readCursor ? await this.readCursor() : undefined;
    try {
      const response = JSON.parse(
        this.runNative({
          kind: "action",
          app: input.app,
          pid: element.pid,
          path: element.path,
          fingerprint: element.fingerprint,
          action: input.action,
          ...(input.text !== undefined ? { text: input.text } : {}),
        }),
      ) as { ok?: unknown };
      if (response.ok !== true)
        throw new Error("macOS Accessibility action failed");
      if (before && this.readCursor) {
        const after = await this.readCursor();
        if (cursorChanged(before, after)) {
          throw new Error(
            "USER_INPUT_INTERFERENCE: physical cursor changed during AX action",
          );
        }
      }
    } finally {
      // Every consequential action consumes the tree. The next action must be
      // grounded in a fresh post-action snapshot.
      this.snapshots.delete(input.snapshotId);
      if (this.latestSnapshotByApp.get(input.app) === input.snapshotId) {
        this.latestSnapshotByApp.delete(input.app);
      }
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.expiresAtMs <= now) {
        this.snapshots.delete(id);
        if (this.latestSnapshotByApp.get(snapshot.publicSnapshot.app) === id) {
          this.latestSnapshotByApp.delete(snapshot.publicSnapshot.app);
        }
      }
    }
    while (this.snapshots.size > this.maxSnapshots) {
      const oldestId = this.snapshots.keys().next().value as string | undefined;
      if (!oldestId) break;
      const oldest = this.snapshots.get(oldestId);
      this.snapshots.delete(oldestId);
      if (
        oldest &&
        this.latestSnapshotByApp.get(oldest.publicSnapshot.app) === oldestId
      ) {
        this.latestSnapshotByApp.delete(oldest.publicSnapshot.app);
      }
    }
  }
}
