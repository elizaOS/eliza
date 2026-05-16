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
// System sleep / lock integration:
// - On system sleep, screen lock, or screens-off, we emit a synthetic
//   `deactivate` for the last-activated app so downstream sleep inference
//   does not treat a lingering frontmost app as hours of continuous use.
// - On wake / unlock, we re-emit an `activate` for the current frontmost app.
//
// The TypeScript service spawns this helper, pipes stdout, and persists events.

#if os(macOS)
import Foundation
import AppKit
import CoreGraphics

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

// Emit a periodic HID idle sample so LifeOps can infer passive-media vs
// away-from-keyboard without depending on the Electrobun desktop bridge.
// CGEventSourceSecondsSinceLastEventType is session-bound; it reports the
// idle time for the active console session which is exactly what we want
// for the signed-in owner.
func emitHidIdle(_ idleSeconds: Double) {
    let tsMs = Int64(Date().timeIntervalSince1970 * 1000)
    let rounded = max(0, Int(idleSeconds.rounded()))
    let line = "{\"ts\":\(tsMs),\"event\":\"hid_idle\",\"idleSeconds\":\(rounded)}\n"
    FileHandle.standardOutput.write(line.data(using: .utf8) ?? Data())
}

func currentHidIdleSeconds() -> Double {
    // `anyInputEventType` covers mouse + keyboard; using combinedSessionState
    // so we read idle for the active session, not the process.
    let anyInputEventType = CGEventType(rawValue: UInt32.max)!
    return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInputEventType)
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
    var lastActivatedAppName: String?

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
        // macOS does not fire NSWorkspace.didDeactivateApplicationNotification
        // when the system sleeps, the screen locks, or the screensaver kicks
        // in. Without a synthetic deactivate the last-activated app looks
        // "focused" for hours, which hides sleep from downstream inference.
        let systemDeactivateNames: [Notification.Name] = [
            NSWorkspace.willSleepNotification,
            NSWorkspace.screensDidSleepNotification,
            NSWorkspace.sessionDidResignActiveNotification,
        ]
        for name in systemDeactivateNames {
            nc.addObserver(
                forName: name,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.emitSystemDeactivate(reason: name.rawValue)
            }
        }
        let systemActivateNames: [Notification.Name] = [
            NSWorkspace.didWakeNotification,
            NSWorkspace.screensDidWakeNotification,
            NSWorkspace.sessionDidBecomeActiveNotification,
        ]
        for name in systemActivateNames {
            nc.addObserver(
                forName: name,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.emitSystemActivate()
            }
        }
        // The screen-locked / screen-unlocked notifications live on the
        // Distributed Notification Center, not the workspace center.
        let dnc = DistributedNotificationCenter.default()
        dnc.addObserver(
            forName: Notification.Name("com.apple.screenIsLocked"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.emitSystemDeactivate(reason: "screenIsLocked")
        }
        dnc.addObserver(
            forName: Notification.Name("com.apple.screenIsUnlocked"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.emitSystemActivate()
        }

        // Emit the current frontmost app as a synthetic first activate so the
        // consumer has a starting anchor for duration computation.
        if let current = workspace.frontmostApplication {
            let bundleId = current.bundleIdentifier ?? ""
            let appName = current.localizedName ?? ""
            let title = frontmostWindowTitle(for: current)
            lastActivatedBundleId = bundleId
            lastActivatedAppName = appName
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
        lastActivatedAppName = appName
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

    func emitSystemDeactivate(reason: String) {
        guard let bundleId = lastActivatedBundleId else { return }
        let appName = lastActivatedAppName ?? ""
        emit(event: "deactivate", bundleId: bundleId, appName: appName, windowTitle: nil)
        // Clear so a subsequent deactivate does not double-emit for the same
        // system-sleep transition.
        lastActivatedBundleId = nil
        lastActivatedAppName = nil
        _ = reason
    }

    func emitSystemActivate() {
        guard let current = workspace.frontmostApplication else { return }
        let bundleId = current.bundleIdentifier ?? ""
        let appName = current.localizedName ?? ""
        let title = frontmostWindowTitle(for: current)
        lastActivatedBundleId = bundleId
        lastActivatedAppName = appName
        emit(event: "activate", bundleId: bundleId, appName: appName, windowTitle: title)
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

// Periodic HID idle sampling. 30s cadence is cheap and gives the LifeOps
// scorer enough resolution to distinguish passive-media from away-from-desk
// (20 min idle is the awake_state timeout in `sleep-wake-spec.md`).
let hidIdleTimer = DispatchSource.makeTimerSource(queue: .main)
hidIdleTimer.schedule(deadline: .now() + .seconds(5), repeating: .seconds(30))
hidIdleTimer.setEventHandler {
    emitHidIdle(currentHidIdleSeconds())
}
hidIdleTimer.resume()

RunLoop.main.run()
#else
// Non-Darwin stub — the Swift compiler is only expected on macOS. We still
// compile this file cleanly on Linux so CI type-checks don't explode.
import Foundation
FileHandle.standardError.write("[activity-collector] This helper only runs on macOS.\n".data(using: .utf8) ?? Data())
exit(2)
#endif
