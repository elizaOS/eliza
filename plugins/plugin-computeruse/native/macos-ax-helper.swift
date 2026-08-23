/**
 A bounded JSON subprocess for app-scoped macOS Accessibility snapshots and
 semantic actions. It never prompts for trust, moves the system pointer, or
 emits clipboard contents; the TypeScript host owns policy and timeouts.
 */

import AppKit
import ApplicationServices
import Foundation

enum HelperFailure: Error {
    case invalidRequest(String)
    case appNotFound(String)
    case accessibilityDenied
    case staleElement(String)
}

func fail(_ error: Error) -> Never {
    let message: String
    switch error {
    case HelperFailure.invalidRequest(let value),
         HelperFailure.appNotFound(let value),
         HelperFailure.staleElement(let value):
        message = value
    case HelperFailure.accessibilityDenied:
        message = "macOS Accessibility permission is not granted"
    default:
        message = String(describing: error)
    }
    let payload: [String: Any] = ["ok": false, "error": ["message": message]]
    let data = try! JSONSerialization.data(withJSONObject: payload)
    FileHandle.standardOutput.write(data)
    Foundation.exit(1)
}

func respond(_ result: Any) -> Never {
    let payload: [String: Any] = ["ok": true, "result": result]
    do {
        let data = try JSONSerialization.data(withJSONObject: payload)
        FileHandle.standardOutput.write(data)
        Foundation.exit(0)
    } catch {
        fail(error)
    }
}

func requestDictionary() throws -> [String: Any] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw HelperFailure.invalidRequest("Request must be a JSON object")
    }
    return value
}

func runningApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy != .prohibited && !$0.isTerminated }
        .sorted {
            let left = $0.localizedName ?? ""
            let right = $1.localizedName ?? ""
            if left == right { return $0.processIdentifier < $1.processIdentifier }
            return left.localizedCaseInsensitiveCompare(right) == .orderedAscending
        }
}

func appId(_ app: NSRunningApplication) -> String {
    app.bundleIdentifier ?? "pid:\(app.processIdentifier)"
}

func appObject(_ app: NSRunningApplication) -> [String: Any] {
    var value: [String: Any] = [
        "id": appId(app),
        "name": app.localizedName ?? app.bundleIdentifier ?? "Unknown",
        "pid": Int(app.processIdentifier),
        "active": app.isActive,
    ]
    if let bundleId = app.bundleIdentifier { value["bundleId"] = bundleId }
    if let path = app.bundleURL?.path { value["path"] = path }
    return value
}

func findApp(_ identifier: String) throws -> NSRunningApplication {
    guard let app = runningApps().first(where: {
        appId($0) == identifier ||
        $0.bundleIdentifier == identifier ||
        $0.localizedName?.localizedCaseInsensitiveCompare(identifier) == .orderedSame
    }) else {
        throw HelperFailure.appNotFound("Running app not found: \(identifier)")
    }
    return app
}

func copyAttribute(_ element: AXUIElement, _ attribute: CFString) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
    copyAttribute(element, attribute) as? String
}

func boolAttribute(_ element: AXUIElement, _ attribute: CFString, default fallback: Bool) -> Bool {
    (copyAttribute(element, attribute) as? NSNumber)?.boolValue ?? fallback
}

func pointAttribute(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
    guard let object = copyAttribute(element, attribute),
          CFGetTypeID(object) == AXValueGetTypeID() else { return nil }
    let value = object as! AXValue
    guard AXValueGetType(value) == .cgPoint else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(value, .cgPoint, &point) ? point : nil
}

func sizeAttribute(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
    guard let object = copyAttribute(element, attribute),
          CFGetTypeID(object) == AXValueGetTypeID() else { return nil }
    let value = object as! AXValue
    guard AXValueGetType(value) == .cgSize else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(value, .cgSize, &size) ? size : nil
}

func boundsObject(_ element: AXUIElement) -> [String: Any]? {
    guard let point = pointAttribute(element, kAXPositionAttribute as CFString),
          let size = sizeAttribute(element, kAXSizeAttribute as CFString) else { return nil }
    return ["x": point.x, "y": point.y, "width": size.width, "height": size.height]
}

func actionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    (copyAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
}

func isSecure(role: String, subrole: String?, description: String?) -> Bool {
    let haystack = [role, subrole ?? "", description ?? ""].joined(separator: " ").lowercased()
    return haystack.contains("secure") || haystack.contains("password")
}

func redactSensitive(_ value: String) -> String {
    let patterns = [
        #"(?i)\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*\S+"#,
        #"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+"#,
        #"://[^/@\s]+:[^/@\s]+@"#,
    ]
    var redacted = value
    for pattern in patterns {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
        let range = NSRange(redacted.startIndex..<redacted.endIndex, in: redacted)
        redacted = regex.stringByReplacingMatches(
            in: redacted,
            range: range,
            withTemplate: "[redacted]"
        )
    }
    return redacted
}

struct WalkItem {
    let element: AXUIElement
    let locator: [Int]
}

func snapshot(_ app: NSRunningApplication) -> [String: Any] {
    if !AXIsProcessTrusted() {
        return [
            "app": appObject(app),
            "capturedAt": ISO8601DateFormatter().string(from: Date()),
            "permission": "accessibility_denied",
            "elements": [],
            "axText": "Accessibility permission unavailable",
        ]
    }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    var queue = [WalkItem(element: root, locator: [])]
    var cursor = 0
    var output: [[String: Any]] = []
    var textLines: [String] = []
    var focusedWindowBounds: [String: Any]?
    while cursor < queue.count {
        let item = queue[cursor]
        cursor += 1
        let role = stringAttribute(item.element, kAXRoleAttribute as CFString) ?? "AXUnknown"
        let subrole = stringAttribute(item.element, kAXSubroleAttribute as CFString)
        let title = stringAttribute(item.element, kAXTitleAttribute as CFString)
        let rawLabel = title ?? stringAttribute(item.element, kAXLabelValueAttribute as CFString)
        let rawDescription = stringAttribute(item.element, kAXDescriptionAttribute as CFString)
        let secure = isSecure(role: role, subrole: subrole, description: rawDescription)
        let label = rawLabel.map(redactSensitive)
        let description = rawDescription.map(redactSensitive)
        let rawValue = secure ? nil : stringAttribute(item.element, kAXValueAttribute as CFString).map(redactSensitive)
        let bounds = boundsObject(item.element)
        var element: [String: Any] = [
            "locator": item.locator,
            "role": role,
            "actions": actionNames(item.element),
            "enabled": boolAttribute(item.element, kAXEnabledAttribute as CFString, default: true),
            "focused": boolAttribute(item.element, kAXFocusedAttribute as CFString, default: false),
            "secure": secure,
        ]
        if let subrole { element["subrole"] = subrole }
        if let label { element["label"] = label }
        if let description { element["description"] = description }
        if let rawValue { element["value"] = rawValue }
        if let bounds { element["bounds"] = bounds }
        if let selected = copyAttribute(item.element, kAXSelectedAttribute as CFString) as? NSNumber {
            element["selected"] = selected.boolValue
        }
        output.append(element)
        let visibleValue = secure ? "[secure value redacted]" : (rawValue ?? "")
        textLines.append("[\(output.count)] \(role) \(label ?? "") \(visibleValue)")
        if focusedWindowBounds == nil && role == (kAXWindowRole as String) {
            let focused = boolAttribute(item.element, kAXFocusedAttribute as CFString, default: false)
            if focused || bounds != nil { focusedWindowBounds = bounds }
        }
        for (index, child) in children(item.element).enumerated() {
            queue.append(WalkItem(element: child, locator: item.locator + [index]))
        }
    }
    var result: [String: Any] = [
        "app": appObject(app),
        "capturedAt": ISO8601DateFormatter().string(from: Date()),
        "permission": "ready",
        "elements": output,
        "axText": textLines.joined(separator: "\n"),
    ]
    if let focusedWindowBounds { result["focusedWindowBounds"] = focusedWindowBounds }
    return result
}

func resolve(_ root: AXUIElement, locator: [Int]) throws -> AXUIElement {
    var element = root
    for index in locator {
        let available = children(element)
        guard index >= 0 && index < available.count else {
            throw HelperFailure.staleElement("Accessibility element path is stale")
        }
        element = available[index]
    }
    return element
}

func matchesExpected(_ element: AXUIElement, _ expected: [String: Any]?) -> Bool {
    guard let expected else { return true }
    if let role = expected["role"] as? String,
       role != stringAttribute(element, kAXRoleAttribute as CFString) { return false }
    if let label = expected["label"] as? String {
        let actual = stringAttribute(element, kAXTitleAttribute as CFString) ??
            stringAttribute(element, kAXLabelValueAttribute as CFString)
        if actual.map(redactSensitive) != label { return false }
    }
    return true
}

func postKey(pid: pid_t, keyCode: CGKeyCode, modifiers: CGEventFlags = []) -> Bool {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else { return false }
    down.flags = modifiers
    up.flags = modifiers
    down.postToPid(pid)
    up.postToPid(pid)
    return true
}

func typeText(pid: pid_t, text: String) -> Bool {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { return false }
    let units = Array(text.utf16)
    units.withUnsafeBufferPointer { pointer in
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: pointer.baseAddress!)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: pointer.baseAddress!)
    }
    down.postToPid(pid)
    up.postToPid(pid)
    return true
}

func keyCode(_ key: String) -> CGKeyCode? {
    let map: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51,
        "escape": 53, "left": 123, "right": 124, "down": 125, "up": 126,
    ]
    return map[key.lowercased()]
}

func modifierFlags(_ values: [String]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for value in values.map({ $0.lowercased() }) {
        if value == "cmd" || value == "command" { flags.insert(.maskCommand) }
        if value == "shift" { flags.insert(.maskShift) }
        if value == "option" || value == "alt" { flags.insert(.maskAlternate) }
        if value == "control" || value == "ctrl" { flags.insert(.maskControl) }
    }
    return flags
}

typealias PasteboardSnapshot = [[NSPasteboard.PasteboardType: Data]]

func snapshotPasteboard(_ pasteboard: NSPasteboard) -> PasteboardSnapshot {
    (pasteboard.pasteboardItems ?? []).map { item in
        var row: [NSPasteboard.PasteboardType: Data] = [:]
        for type in item.types {
            if let data = item.data(forType: type) { row[type] = data }
        }
        return row
    }
}

func restorePasteboard(_ pasteboard: NSPasteboard, snapshot: PasteboardSnapshot) {
    pasteboard.clearContents()
    let items = snapshot.map { row -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, data) in row { item.setData(data, forType: type) }
        return item
    }
    if !items.isEmpty { pasteboard.writeObjects(items) }
}

func paste(pid: pid_t, text: String, format: String) -> (success: Bool, restored: Bool) {
    let pasteboard = NSPasteboard.general
    let original = snapshotPasteboard(pasteboard)
    pasteboard.clearContents()
    let item = NSPasteboardItem()
    let type: NSPasteboard.PasteboardType = format == "html" ? .html : .string
    item.setString(text, forType: type)
    if format == "markdown" { item.setString(text, forType: .string) }
    pasteboard.writeObjects([item])
    let injectedChangeCount = pasteboard.changeCount
    let posted = postKey(pid: pid, keyCode: 9, modifiers: .maskCommand)
    Thread.sleep(forTimeInterval: 0.08)
    if pasteboard.changeCount == injectedChangeCount {
        restorePasteboard(pasteboard, snapshot: original)
        return (posted, true)
    }
    return (posted, false)
}

func perform(_ request: [String: Any]) throws -> [String: Any] {
    guard AXIsProcessTrusted() else { throw HelperFailure.accessibilityDenied }
    guard let identifier = request["app"] as? String,
          let action = request["action"] as? String else {
        throw HelperFailure.invalidRequest("perform requires app and action")
    }
    let app = try findApp(identifier)
    let root = AXUIElementCreateApplication(app.processIdentifier)
    let locator = request["locator"] as? [Int]
    let element = try locator.map { try resolve(root, locator: $0) }
    if let element, !matchesExpected(element, request["expected"] as? [String: Any]) {
        throw HelperFailure.staleElement("Accessibility element no longer matches the captured state")
    }
    let text = request["text"] as? String ?? ""
    var success = false
    var clipboardRestored: Bool?
    switch action {
    case "click":
        if let element {
            let exposed = actionNames(element)
            let preferred = [kAXPressAction as String, kAXConfirmAction as String]
                .first(where: { exposed.contains($0) })
            if let preferred { success = AXUIElementPerformAction(element, preferred as CFString) == .success }
        }
    case "secondary_action":
        if let element, let secondary = request["secondaryAction"] as? String,
           actionNames(element).contains(secondary) {
            success = AXUIElementPerformAction(element, secondary as CFString) == .success
        }
    case "set_value":
        if let element { success = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef) == .success }
    case "select_text":
        if let element, let value = stringAttribute(element, kAXValueAttribute as CFString),
           let range = value.range(of: text) {
            let location = value.utf16.distance(from: value.utf16.startIndex, to: range.lowerBound.samePosition(in: value.utf16)!)
            let length = text.utf16.count
            var cfRange = CFRange(location: location, length: length)
            if let rangeValue = AXValueCreate(.cfRange, &cfRange) {
                success = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, rangeValue) == .success
            }
        }
    case "press_key":
        if let key = request["key"] as? String, let code = keyCode(key) {
            success = postKey(pid: app.processIdentifier, keyCode: code, modifiers: modifierFlags(request["modifiers"] as? [String] ?? []))
        }
    case "type_text":
        success = typeText(pid: app.processIdentifier, text: text)
    case "paste":
        let outcome = paste(pid: app.processIdentifier, text: text, format: request["format"] as? String ?? "text")
        success = outcome.success
        clipboardRestored = outcome.restored
    case "scroll":
        if let element {
            let direction = request["direction"] as? String ?? "down"
            let candidate = direction == "up" ? "AXScrollUpByPage" : direction == "left" ? "AXScrollLeftByPage" : direction == "right" ? "AXScrollRightByPage" : "AXScrollDownByPage"
            if actionNames(element).contains(candidate) {
                success = AXUIElementPerformAction(element, candidate as CFString) == .success
            }
        }
    default:
        throw HelperFailure.invalidRequest("Unsupported app action: \(action)")
    }
    var result: [String: Any] = ["success": success]
    if !success { result["error"] = "The accessibility element did not expose a matching semantic action" }
    if let clipboardRestored { result["clipboardRestored"] = clipboardRestored }
    return result
}

do {
    let request = try requestDictionary()
    guard let command = request["command"] as? String else {
        throw HelperFailure.invalidRequest("command is required")
    }
    switch command {
    case "list_apps": respond(runningApps().map(appObject))
    case "get_app_state":
        guard let identifier = request["app"] as? String else {
            throw HelperFailure.invalidRequest("app is required")
        }
        respond(snapshot(try findApp(identifier)))
    case "perform": respond(try perform(request))
    default: throw HelperFailure.invalidRequest("Unknown command: \(command)")
    }
} catch {
    fail(error)
}
