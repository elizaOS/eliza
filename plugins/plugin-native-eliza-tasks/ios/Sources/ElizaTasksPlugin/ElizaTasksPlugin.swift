import BackgroundTasks
import Capacitor
import Foundation
import UIKit
import UserNotifications

/// ElizaTasksPlugin — Capacitor bridge for iOS `BGTaskScheduler`.
///
/// Registers two namespaced identifiers in `BGTaskScheduler.shared.register`:
///
///   - `ai.eliza.tasks.refresh`     → `BGAppRefreshTask` (≤ ~30s, network-OK)
///   - `ai.eliza.tasks.processing`  → `BGProcessingTask` (long-running,
///                                     requires charger, no network)
///
/// On wake, the plugin emits a `wake` event to the JS layer carrying
/// `{kind, identifier, deadlineSec, firedAtMs, payload}`. The Wave 3D JS
/// runner under `runners/eliza-tasks.js` consumes the same event shape from
/// the `@capacitor/background-runner` repeat poll, so the JS-side handler is
/// shared between the two wake paths.
///
/// Silent-push wake (`remote-notification` UIBackgroundMode) is plumbed
/// through `AppDelegate.application:didReceiveRemoteNotification:` which
/// posts an `ElizaCompanionRemotePush` `NSNotification`. This plugin
/// observes that notification and forwards the payload as a third wake
/// `kind: "remote-push"` event. APNs registration is still gated on the
/// `ELIZA_APNS_ENABLED` Info.plist flag and defaults off.
///
/// JS-callable methods:
///   - `scheduleNext({ earliestBeginSec, alsoProcessing })`
///   - `getStatus()`
///   - `cancelAll()`
@objc(ElizaTasksPlugin)
public class ElizaTasksPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ElizaTasksPlugin"
    public let jsName = "ElizaTasks"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scheduleNext", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelAll", returnType: CAPPluginReturnPromise),
    ]

    // The identifiers MUST match the values declared in Info.plist's
    // `BGTaskSchedulerPermittedIdentifiers` array. If they drift, `register`
    // returns false and the OS refuses to dispatch tasks.
    private static let refreshIdentifier = "ai.eliza.tasks.refresh"
    private static let processingIdentifier = "ai.eliza.tasks.processing"
    private static let remotePushIdentifier = "ai.eliza.tasks.remote-push"

    // Default earliestBegin if the JS caller does not supply one. Apple's
    // documented practical minimum is 15 minutes; we honor that as the floor.
    private static let defaultEarliestBeginSec: Double = 15 * 60

    // Apple's WWDC guidance: BGAppRefreshTask gets ~30s, BGProcessingTask
    // gets minutes. The JS runner consumes deadlineSec to size its own
    // hard-deadline race.
    private static let refreshDeadlineSec: Double = 25
    private static let processingDeadlineSec: Double = 120

    // Persistence keys — used by `getStatus` so the JS side can observe wake
    // events that landed before the webview was ready to receive listeners.
    private static let lastWakeFiredAtKey = "ai.eliza.tasks.lastWakeFiredAtMs"
    private static let lastWakeKindKey = "ai.eliza.tasks.lastWakeKind"
    private static let refreshScheduledKey = "ai.eliza.tasks.refreshScheduled"
    private static let processingScheduledKey = "ai.eliza.tasks.processingScheduled"

    private var remotePushObserver: NSObjectProtocol?

    public override func load() {
        registerBackgroundTasks()
        observeRemotePush()
    }

    deinit {
        if let observer = remotePushObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - JS-callable surface

    @objc func scheduleNext(_ call: CAPPluginCall) {
        let earliestBeginSec = call.getDouble("earliestBeginSec")
            ?? Self.defaultEarliestBeginSec
        let alsoProcessing = call.getBool("alsoProcessing") ?? false

        // Floor at 1s — BGTaskScheduler returns an error for negative or
        // zero values, and very small intervals are silently coerced anyway.
        let normalizedBegin = max(1.0, earliestBeginSec)
        let beginDate = Date(timeIntervalSinceNow: normalizedBegin)

        let refreshResult = submitRefreshRequest(beginDate: beginDate)
        if alsoProcessing {
            _ = submitProcessingRequest(beginDate: beginDate)
        }

        call.resolve([
            "scheduled": refreshResult.scheduled,
            "identifier": Self.refreshIdentifier,
            "earliestBeginAtMs": refreshResult.scheduled
                ? Int64(beginDate.timeIntervalSince1970 * 1000)
                : NSNull(),
            "reason": refreshResult.reason as Any? ?? NSNull(),
        ])
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        let defaults = UserDefaults.standard
        let lastWakeMs = defaults.object(forKey: Self.lastWakeFiredAtKey) as? Int64
        let lastKind = defaults.string(forKey: Self.lastWakeKindKey)

        call.resolve([
            "supported": true,
            "platform": "ios",
            "refreshScheduled": defaults.bool(forKey: Self.refreshScheduledKey),
            "processingScheduled": defaults.bool(forKey: Self.processingScheduledKey),
            "lastWakeFiredAtMs": lastWakeMs.map { $0 as Any } ?? NSNull(),
            "lastWakeKind": lastKind as Any? ?? NSNull(),
            "reason": NSNull(),
        ])
    }

    @objc func cancelAll(_ call: CAPPluginCall) {
        BGTaskScheduler.shared.cancelAllTaskRequests()
        let defaults = UserDefaults.standard
        defaults.set(false, forKey: Self.refreshScheduledKey)
        defaults.set(false, forKey: Self.processingScheduledKey)
        call.resolve(["cancelled": true])
    }

    // MARK: - BGTaskScheduler registration

    /// Register the two BG task handlers. Must run before
    /// `application:didFinishLaunchingWithOptions:` returns. CAPPlugin.load()
    /// runs after `didFinishLaunching` but BGTaskScheduler tolerates this if
    /// the identifier is in Info.plist's permitted list — the OS queues the
    /// dispatch until a handler is registered. Confirmed on iOS 15+.
    private func registerBackgroundTasks() {
        let scheduler = BGTaskScheduler.shared

        let refreshRegistered = scheduler.register(
            forTaskWithIdentifier: Self.refreshIdentifier,
            using: nil
        ) { [weak self] task in
            guard let self = self else {
                task.setTaskCompleted(success: false)
                return
            }
            self.handleRefreshTask(task)
        }

        let processingRegistered = scheduler.register(
            forTaskWithIdentifier: Self.processingIdentifier,
            using: nil
        ) { [weak self] task in
            guard let self = self else {
                task.setTaskCompleted(success: false)
                return
            }
            self.handleProcessingTask(task)
        }

        if !refreshRegistered {
            NSLog(
                "[ElizaTasksPlugin] BGTaskScheduler.register(%@) returned false — verify Info.plist BGTaskSchedulerPermittedIdentifiers",
                Self.refreshIdentifier
            )
        }
        if !processingRegistered {
            NSLog(
                "[ElizaTasksPlugin] BGTaskScheduler.register(%@) returned false — verify Info.plist BGTaskSchedulerPermittedIdentifiers",
                Self.processingIdentifier
            )
        }
    }

    // MARK: - Task handlers

    private func handleRefreshTask(_ task: BGTask) {
        // Always set an expiration handler before doing async work, otherwise
        // iOS escalates the task termination to a force-kill.
        task.expirationHandler = { [weak task] in
            task?.setTaskCompleted(success: false)
        }

        let firedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
        persistWake(kind: "refresh", firedAtMs: firedAtMs)

        // BG refresh consumers are expected to re-enqueue the next wake before
        // resolving — without this the chain dies after one fire.
        let nextBegin = Date(timeIntervalSinceNow: Self.defaultEarliestBeginSec)
        _ = submitRefreshRequest(beginDate: nextBegin)

        emitWake(
            kind: "refresh",
            identifier: Self.refreshIdentifier,
            deadlineSec: Self.refreshDeadlineSec,
            firedAtMs: firedAtMs,
            payload: [:]
        )

        // The JS handler runs in the webview, which may be backgrounded. We
        // signal completion eagerly — the runner's HTTP poke is fire-and-forget
        // from the OS's perspective; the agent's loopback `/api/internal/wake`
        // route owns durability.
        task.setTaskCompleted(success: true)
    }

    private func handleProcessingTask(_ task: BGTask) {
        task.expirationHandler = { [weak task] in
            task?.setTaskCompleted(success: false)
        }

        let firedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
        persistWake(kind: "processing", firedAtMs: firedAtMs)

        emitWake(
            kind: "processing",
            identifier: Self.processingIdentifier,
            deadlineSec: Self.processingDeadlineSec,
            firedAtMs: firedAtMs,
            payload: [:]
        )

        // Processing tasks are not auto-rescheduled — the JS layer requests
        // the next processing wake explicitly when a warmup window is needed.
        task.setTaskCompleted(success: true)
    }

    // MARK: - Submit helpers

    private struct SubmitResult {
        let scheduled: Bool
        let reason: String?
    }

    private func submitRefreshRequest(beginDate: Date) -> SubmitResult {
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshIdentifier)
        request.earliestBeginDate = beginDate
        do {
            try BGTaskScheduler.shared.submit(request)
            UserDefaults.standard.set(true, forKey: Self.refreshScheduledKey)
            return SubmitResult(scheduled: true, reason: nil)
        } catch {
            UserDefaults.standard.set(false, forKey: Self.refreshScheduledKey)
            let message = "BGTaskScheduler.submit(refresh) failed: \(error.localizedDescription)"
            NSLog("[ElizaTasksPlugin] %@", message)
            return SubmitResult(scheduled: false, reason: message)
        }
    }

    private func submitProcessingRequest(beginDate: Date) -> SubmitResult {
        let request = BGProcessingTaskRequest(identifier: Self.processingIdentifier)
        request.earliestBeginDate = beginDate
        // Eliza's processing task is the local-LLM warmup pass. Real-world
        // semantics: only run while plugged in, no network needed (the agent
        // is reachable on loopback inside the app process).
        request.requiresExternalPower = true
        request.requiresNetworkConnectivity = false
        do {
            try BGTaskScheduler.shared.submit(request)
            UserDefaults.standard.set(true, forKey: Self.processingScheduledKey)
            return SubmitResult(scheduled: true, reason: nil)
        } catch {
            UserDefaults.standard.set(false, forKey: Self.processingScheduledKey)
            let message = "BGTaskScheduler.submit(processing) failed: \(error.localizedDescription)"
            NSLog("[ElizaTasksPlugin] %@", message)
            return SubmitResult(scheduled: false, reason: message)
        }
    }

    // MARK: - Remote push plumbing

    /// AppDelegate's `application:didReceiveRemoteNotification:` posts an
    /// `ElizaCompanionRemotePush` notification with the userInfo dictionary
    /// in `object`. We surface that to JS as a third wake kind so the same
    /// `wake` event handler can drain it. Gated on the operator flipping
    /// `ELIZA_APNS_ENABLED=1` in Info.plist — silent until then.
    private func observeRemotePush() {
        remotePushObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("ElizaCompanionRemotePush"),
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self = self else { return }
            let userInfo = (notification.object as? [AnyHashable: Any]) ?? [:]
            var payload: [String: Any] = [:]
            for (key, value) in userInfo {
                guard let stringKey = key as? String, stringKey != "aps" else { continue }
                payload[stringKey] = value
            }
            let firedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            self.persistWake(kind: "remote-push", firedAtMs: firedAtMs)
            self.emitWake(
                kind: "remote-push",
                identifier: Self.remotePushIdentifier,
                deadlineSec: Self.refreshDeadlineSec,
                firedAtMs: firedAtMs,
                payload: payload
            )
        }
    }

    // MARK: - Event emission

    private func emitWake(
        kind: String,
        identifier: String,
        deadlineSec: Double,
        firedAtMs: Int64,
        payload: [String: Any]
    ) {
        notifyListeners("wake", data: [
            "kind": kind,
            "identifier": identifier,
            "deadlineSec": deadlineSec,
            "firedAtMs": firedAtMs,
            "payload": payload,
        ])
    }

    private func persistWake(kind: String, firedAtMs: Int64) {
        let defaults = UserDefaults.standard
        defaults.set(firedAtMs, forKey: Self.lastWakeFiredAtKey)
        defaults.set(kind, forKey: Self.lastWakeKindKey)
    }
}
