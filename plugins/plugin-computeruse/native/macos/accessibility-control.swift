import AppKit
import ApplicationServices
import Foundation

enum AXControlError: Error, CustomStringConvertible {
  case named(String)

  var description: String {
    switch self {
    case .named(let value): return value
    }
  }
}

func fail(_ name: String) throws -> Never {
  throw AXControlError.named(name)
}

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
  guard
    CFGetTypeID(value) == AXValueGetTypeID(),
    AXValueGetValue(value as! AXValue, .cgPoint, &point)
  else { return .zero }
  return point
}

func sizeAttribute(_ element: AXUIElement, _ name: CFString) -> CGSize {
  guard let value = copyAttribute(element, name) else { return .zero }
  var size = CGSize.zero
  guard
    CFGetTypeID(value) == AXValueGetTypeID(),
    AXValueGetValue(value as! AXValue, .cgSize, &size)
  else { return .zero }
  return size
}

func actionNames(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
  return names as? [String] ?? []
}

func jsonString(_ value: Any) -> String {
  guard
    let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  else { return "" }
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
  let fingerprint = jsonString([
    role,
    subrole,
    title.isEmpty ? description : title,
    identifier,
    bbox,
  ])
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
  guard let first = path.first, first >= 0, first < windows.count else {
    try fail("AX_ELEMENT_GONE")
  }
  var element = windows[first]
  for index in path.dropFirst() {
    let children = elementsAttribute(element, kAXChildrenAttribute as CFString)
    guard index >= 0, index < children.count else { try fail("AX_ELEMENT_GONE") }
    element = children[index]
  }
  return element
}

func perform(_ element: AXUIElement, _ action: CFString) throws {
  guard AXUIElementPerformAction(element, action) == .success else {
    try fail("AX_ACTION_UNSUPPORTED")
  }
}

do {
  let input = FileHandle.standardInput.readDataToEndOfFile()
  guard
    let request = try JSONSerialization.jsonObject(with: input) as? [String: Any],
    let appName = request["app"] as? String
  else { try fail("AX_INVALID_REQUEST") }

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
    var queue: [(AXUIElement, [Int], Int)] = windows.enumerated().map {
      ($0.element, [$0.offset], 0)
    }
    var cursor = 0
    var output: [[String: Any]] = []
    while cursor < queue.count && output.count < 500 {
      let current = queue[cursor]
      cursor += 1
      output.append(describe(current.0, path: current.1))
      if current.2 >= 12 { continue }
      let children = elementsAttribute(current.0, kAXChildrenAttribute as CFString)
      for (index, child) in children.enumerated()
      where output.count + queue.count - cursor < 500 {
        queue.append((child, current.1 + [index], current.2 + 1))
      }
    }
    let result: [String: Any] = ["app": appName, "pid": pid, "elements": output]
    let data = try JSONSerialization.data(withJSONObject: result)
    FileHandle.standardOutput.write(data)
    exit(0)
  }

  guard
    request["kind"] as? String == "action",
    request["pid"] as? Int == pid,
    let path = request["path"] as? [Int],
    let expectedFingerprint = request["fingerprint"] as? String,
    let action = request["action"] as? String
  else { try fail("AX_APP_GENERATION_CHANGED") }

  let element = try resolveElement(appElement, path: path)
  guard describe(element, path: path)["fingerprint"] as? String == expectedFingerprint else {
    try fail("AX_STALE_ELEMENT")
  }

  switch action {
  case "press":
    try perform(element, kAXPressAction as CFString)
  case "confirm":
    try perform(element, "AXConfirm" as CFString)
  case "raise":
    running.activate()
    try perform(element, kAXRaiseAction as CFString)
  case "focus":
    running.activate()
    guard
      AXUIElementSetAttributeValue(
        element,
        kAXFocusedAttribute as CFString,
        kCFBooleanTrue
      ) == .success
    else { try fail("AX_ACTION_UNSUPPORTED") }
  case "set_value":
    guard let text = request["text"] as? String else { try fail("AX_VALUE_REQUIRED") }
    guard
      AXUIElementSetAttributeValue(
        element,
        kAXValueAttribute as CFString,
        text as CFTypeRef
      ) == .success
    else { try fail("AX_ACTION_UNSUPPORTED") }
  case "scroll_up":
    try perform(element, "AXScrollUp" as CFString)
  case "scroll_down":
    try perform(element, "AXScrollDown" as CFString)
  case "scroll_left":
    try perform(element, "AXScrollLeft" as CFString)
  case "scroll_right":
    try perform(element, "AXScrollRight" as CFString)
  default:
    try fail("AX_UNKNOWN_ACTION")
  }

  FileHandle.standardOutput.write(Data("{\"ok\":true}".utf8))
} catch {
  FileHandle.standardError.write(Data(String(describing: error).utf8))
  exit(2)
}
