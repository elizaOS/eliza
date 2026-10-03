import Foundation
import UIKit

/// Structured boot-trace sink for on-device startup observability.
///
/// The iOS boot path has no attached console in the launch contexts that
/// matter (icon tap, XCUITest-owned launches), so every startup stage —
/// native plugin lifecycle, watchdog probes, agent state transitions
/// including the FULL error detail — is appended as one JSON line to
///
///     <appDataContainer>/Documents/eliza-boot-trace.jsonl
///
/// which is retrievable WITHOUT a console via:
///
///     xcrun devicectl device copy from \
///       --device <id> --domain-type appDataContainer \
///       --domain-identifier ai.elizaos.app \
///       --source Documents/eliza-boot-trace.jsonl --destination <out>
///
/// The renderer appends into the SAME file via the Agent plugin's
/// `appendBootTrace` bridge method (see
/// packages/ui/src/api/ios-local-agent-transport.ts), which posts
/// `appendNotification` — this queue stays the single writer.
///
/// Design constraints:
/// - Appends are serialized on a private queue; each entry is a single
///   `\n`-terminated JSON object (JSONL).
/// - The file is bounded: when it exceeds ~1 MB it is rotated to
///   `eliza-boot-trace.prev.jsonl` (one generation kept).
/// - The file is created with `FileProtectionType.none` so stage events
///   written before first unlock are never lost to data protection — and so a
///   file-protection failure can itself be observed rather than silently
///   swallowing the trace.
/// - Modules that cannot import the app target (e.g. the AgentPlugin pod)
///   post `ElizaStartupTrace.appendNotification` with
///   `userInfo = ["source": String, "stage": String, "detail": [String: Any]]`;
///   the observer registered by `bootstrap()` appends on their behalf.
enum ElizaStartupTrace {
    static let currentId: String = {
        let millis = Int(Date().timeIntervalSince1970 * 1000)
        return "ios-\(millis)-\(UUID().uuidString.lowercased())"
    }()

    static var documentStartScript: String {
        "window.__ELIZA_STARTUP_TRACE_ID__ = \"\(currentId)\";"
    }

    /// Cross-module append channel (used by CocoaPods plugin targets that
    /// cannot link against app-target code).
    static let appendNotification = Notification.Name("ElizaBootTraceAppend")

    static let traceFileName = "eliza-boot-trace.jsonl"
    static let rotatedTraceFileName = "eliza-boot-trace.prev.jsonl"
    private static let maxTraceFileBytes = 1_000_000

    private static let processStart = Date()
    private static let queue = DispatchQueue(label: "ai.elizaos.boot-trace", qos: .utility)
    private static var observerToken: NSObjectProtocol?
    private static var bootstrapped = false

    static var traceFileURL: URL? {
        FileManager.default
            .urls(for: .documentDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent(traceFileName)
    }

    /// Registers the cross-module notification observer and writes the
    /// process-launch entry (environment facts that distinguish launch paths:
    /// XCUITest injection, protected-data availability, thermal/power state).
    /// Idempotent; call once, as early as possible in `didFinishLaunching`.
    static func bootstrap() {
        queue.sync {
            guard !bootstrapped else { return }
            bootstrapped = true
        }
        observerToken = NotificationCenter.default.addObserver(
            forName: appendNotification,
            object: nil,
            queue: nil
        ) { notification in
            let source = notification.userInfo?["source"] as? String ?? "unknown"
            let stage = notification.userInfo?["stage"] as? String ?? "event"
            let detail = notification.userInfo?["detail"] as? [String: Any] ?? [:]
            append(source: source, stage: stage, detail: detail)
        }

        let env = ProcessInfo.processInfo.environment
        let processInfo = ProcessInfo.processInfo
        var launchDetail: [String: Any] = [
            "xcuiTestConfigPresent": env["XCTestConfigurationFilePath"] != nil,
            "xcuiTestBundlePath": env["XCTestBundlePath"] ?? "",
            "dyldInsertLibraries": env["DYLD_INSERT_LIBRARIES"] ?? "",
            "envKeyCount": env.count,
            "elizaEnvKeys": env.keys.filter { $0.hasPrefix("ELIZA") }.sorted(),
            "activeProcessorCount": processInfo.activeProcessorCount,
            "physicalMemoryMB": Int(processInfo.physicalMemory / (1024 * 1024)),
            "thermalState": describeThermalState(processInfo.thermalState),
            "lowPowerMode": processInfo.isLowPowerModeEnabled,
            "cwd": FileManager.default.currentDirectoryPath,
        ]
        DispatchQueue.main.async {
            launchDetail["applicationState"] = describeApplicationState(UIApplication.shared.applicationState)
            launchDetail["protectedDataAvailable"] = UIApplication.shared.isProtectedDataAvailable
            append(source: "app", stage: "process-launch", detail: launchDetail)
        }
    }

    /// Appends one timestamped JSONL entry. Safe from any thread; never
    /// throws; never logs secrets (callers must pre-redact tokens).
    static func append(source: String, stage: String, detail: [String: Any] = [:]) {
        let now = Date()
        let elapsedMs = Int(now.timeIntervalSince(processStart) * 1000)
        queue.async {
            guard let fileURL = traceFileURL else { return }
            var entry: [String: Any] = [
                "ts": isoTimestamp(now),
                "elapsedMs": elapsedMs,
                "traceId": currentId,
                "source": source,
                "stage": stage,
            ]
            for (key, value) in detail where entry[key] == nil {
                entry[key] = jsonSafe(value)
            }
            guard JSONSerialization.isValidJSONObject(entry),
                  var data = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]) else {
                return
            }
            data.append(0x0A) // newline

            rotateIfNeeded(fileURL: fileURL)

            let fm = FileManager.default
            if !fm.fileExists(atPath: fileURL.path) {
                fm.createFile(
                    atPath: fileURL.path,
                    contents: nil,
                    attributes: [.protectionKey: FileProtectionType.none]
                )
            }
            guard let handle = try? FileHandle(forWritingTo: fileURL) else {
                NSLog("[ElizaStartupTrace] cannot open %@ for append", fileURL.path)
                return
            }
            defer { try? handle.close() }
            do {
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
            } catch {
                NSLog("[ElizaStartupTrace] append failed: %@", error.localizedDescription)
            }
        }
    }

    // MARK: - Internals (queue-confined)

    private static func rotateIfNeeded(fileURL: URL) {
        let fm = FileManager.default
        guard let size = (try? fm.attributesOfItem(atPath: fileURL.path))?[.size] as? NSNumber,
              size.intValue >= maxTraceFileBytes else {
            return
        }
        let rotated = fileURL.deletingLastPathComponent()
            .appendingPathComponent(rotatedTraceFileName)
        try? fm.removeItem(at: rotated)
        try? fm.moveItem(at: fileURL, to: rotated)
    }

    private static func isoTimestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static func describeThermalState(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }

    private static func describeApplicationState(_ state: UIApplication.State) -> String {
        switch state {
        case .active: return "active"
        case .inactive: return "inactive"
        case .background: return "background"
        @unknown default: return "unknown"
        }
    }

    /// JSON-serializable coercion for detail values (mirrors the Capacitor
    /// bridge's tolerance: unknown types degrade to their description).
    private static func jsonSafe(_ value: Any) -> Any {
        switch value {
        case let value as String: return value
        case let value as Bool: return value
        case let value as Int: return value
        case let value as Double: return value
        case let value as NSNumber: return value
        case is NSNull: return NSNull()
        case let value as [Any]: return value.map { jsonSafe($0) }
        case let value as [String: Any]:
            var out: [String: Any] = [:]
            for (k, v) in value { out[k] = jsonSafe(v) }
            return out
        default:
            return String(describing: value)
        }
    }
}
