// activity-collector.swift
//
// Long-running macOS helper that subscribes to NSWorkspace application-focus
// notifications and emits one JSON object per line to stdout.
//
// Build (Darwin only):
//     swiftc -O activity-collector.swift -o activity-collector
//
// Output format (one JSON object per line, trailing \n):
//     {"ts":1714000000000,"event":"activate","bundleId":"com.apple.Safari","appName":"Safari","windowTitle":"Example — Google Search"}
//     {"ts":1714000003000,"event":"deactivate","bundleId":"com.apple.Safari","appName":"Safari"}
//
// Contract:
// - Writes complete lines terminated with \n.
// - Flushes stdout after every line.
// - Exits cleanly on SIGTERM / SIGINT.
// - No stderr output unless a fatal error occurs (stderr line prefixed "[activity-collector] ").
//
// The TypeScript service spawns this helper, pipes stdout, and persists events.

#if os(macOS)
import Foundation
import AppKit

// Avoid Swift's JSONEncoder overhead per-event: build the JSON string manually.
// Escape the minimum set required by RFC 8259 for string scalars.
func jsonEscape(_ s: String) -> String {
    var out = ""
    out.reserveCapacity(s.count + 2)
    for scalar in s.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        case "\u{08}": out += "\\b"
        case "\u{0C}": out += "\\f"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    return out
}

func emit(event: String, bundleId: String, appName: String, windowTitle: String?) {
    let tsMs = Int64(Date().timeIntervalSince1970 * 1000)
    var fields = [
        "\"ts\":\(tsMs)",
        "\"event\":\"\(jsonEscape(event))\"",
        "\"bundleId\":\"\(jsonEscape(bundleId))\"",
        "\"appName\":\"\(jsonEscape(appName))\"",
    ]
    if let title = windowTitle, !title.isEmpty {
        fields.append("\"windowTitle\":\"\(jsonEscape(title))\"")
    }
    let line = "{" + fields.joined(separator: ",") + "}\n"
    FileHandle.standardOutput.write(line.data(using: .utf8) ?? Data())
}

func frontmostWindowTitle(for app: NSRunningApplication) -> String? {
    // Reading the window title requires Accessibility permission. We attempt
    // it via AX API; any failure returns nil (no windowTitle field emitted).
    let pid = app.processIdentifier
    let axApp = AXUIElementCreateApplication(pid)
    var focused: AnyObject?
    let err = AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &focused)
    guard err == .success, let window = focused else { return nil }
    var titleValue: AnyObject?
    let titleErr = AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &titleValue)
    guard titleErr == .success, let titleStr = titleValue as? String else { return nil }
    return titleStr
}

final class Collector {
    let workspace = NSWorkspace.shared
    var lastActivatedBundleId: String?

    func start() {
        let nc = workspace.notificationCenter
        nc.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            self?.handleActivate(note)
        }
        nc.addObserver(
            forName: NSWorkspace.didDeactivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            self?.handleDeactivate(note)
        }

        // Emit the current frontmost app as a synthetic first activate so the
        // consumer has a starting anchor for duration computation.
        if let current = workspace.frontmostApplication {
            let bundleId = current.bundleIdentifier ?? ""
            let appName = current.localizedName ?? ""
            let title = frontmostWindowTitle(for: current)
            lastActivatedBundleId = bundleId
            emit(event: "activate", bundleId: bundleId, appName: appName, windowTitle: title)
        }
    }

    func handleActivate(_ note: Notification) {
        guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else {
            return
        }
        let bundleId = app.bundleIdentifier ?? ""
        let appName = app.localizedName ?? ""
        let title = frontmostWindowTitle(for: app)
        lastActivatedBundleId = bundleId
        emit(event: "activate", bundleId: bundleId, appName: appName, windowTitle: title)
    }

    func handleDeactivate(_ note: Notification) {
        guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else {
            return
        }
        let bundleId = app.bundleIdentifier ?? ""
        let appName = app.localizedName ?? ""
        emit(event: "deactivate", bundleId: bundleId, appName: appName, windowTitle: nil)
    }
}

// Line-buffer stdout so the consumer sees events immediately.
setbuf(stdout, nil)

let signalSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signalSource.setEventHandler { exit(0) }
signalSource.resume()
signal(SIGTERM, SIG_IGN)

let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
intSource.setEventHandler { exit(0) }
intSource.resume()
signal(SIGINT, SIG_IGN)

let collector = Collector()
collector.start()

RunLoop.main.run()
#else
// Non-Darwin stub — the Swift compiler is only expected on macOS. We still
// compile this file cleanly on Linux so CI type-checks don't explode.
import Foundation
FileHandle.standardError.write("[activity-collector] This helper only runs on macOS.\n".data(using: .utf8) ?? Data())
exit(2)
#endif
