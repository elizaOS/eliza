import UIKit
import WebKit
import Capacitor

/// Local-agent crash/restart supervisor for iOS — the parity equivalent of
/// Android's `ElizaAgentService.WatchdogThread`.
///
/// ## Why this exists
///
/// On Android the local Eliza agent is a detached `bun` child process owned by
/// `ElizaAgentService`, which runs a `WatchdogThread`: it polls process
/// liveness + the loopback `/api/health` endpoint, accumulates `HEALTH_FAIL_STRIKES`
/// on a dead/unhealthy probe, and calls `scheduleRestart()` (bounded by
/// `MAX_RESTART_ATTEMPTS = 5`, exponential backoff) to relaunch a crashed agent.
/// iOS had no equivalent — a crashed in-process runtime stayed down until the
/// user force-quit the app. This closes that gap (issue #10197).
///
/// ## iOS reality (NOT a process model)
///
/// On iOS the local agent is **in-process**: it runs inside the app via the
/// `ElizaBunRuntime` Capacitor plugin (`@elizaos/capacitor-bun-runtime`) — either
/// the full `ElizaBunEngine` host or the JSContext compat bridge — driven entirely
/// from the WebView/renderer (`ElizaBunRuntime.start(...)`). There is **no TCP
/// port** (transport is `bun-host-ipc`, NDJSON over anonymous pipes), so there is
/// no socket for native Swift to curl. A "crash" is not process death; it is the
/// in-process runtime tearing down (`isRunning -> false`, the plugin fires the
/// Capacitor `eliza:runtime-exit` event) while the host app keeps running.
///
/// So the watchdog adapts the Android semantics to the in-process world:
///
/// * **Health "endpoint"** → the renderer's authoritative liveness, read through
///   the Capacitor bridge: `window.Capacitor.Plugins.ElizaBunRuntime.getStatus()`
///   (`ready: true` while the engine is up — it stays `true` during a generation,
///   so a busy model is never mistaken for a crash, the same way Android's
///   `ProbeResult.BUSY` never counts a strike).
/// * **Mode gate** → reads the renderer's own source of truth
///   (`localStorage["eliza:mobile-runtime-mode"]`). `cloud` is pure remote and
///   keeps the watchdog dormant. `local`, `cloud-hybrid`, and `tunnel-to-mobile`
///   all own a phone-side agent and therefore arm the watchdog when the runtime
///   plugin is present. An unset mode with the plugin present (fresh install
///   autostart) arms it as well.
/// * **"Restart" entrypoint** → re-initializing the in-process runtime via the
///   renderer's existing `ElizaBunRuntime.start(...)` path. The watchdog does not
///   invent a second restart mechanism and never fabricates a start config it
///   doesn't own; it emits a bounded restart *request* (a NotificationCenter post
///   `AgentWatchdog.restartRequestedNotification` + a `window`
///   `eliza:local-agent-restart-requested` DOM event) that the runtime owner
///   honors by re-running its existing start. The renderer's start is idempotent
///   (it adopts a healthy runtime and re-bootstraps a stale one).
///
/// ## Mirrored bounds
///
/// * `healthFailStrikes = 3` consecutive unhealthy polls before a restart is
///   requested (Android `HEALTH_FAIL_STRIKES`).
/// * `maxRestartAttempts = 5` within a rolling window, then give up and stop
///   polling rather than loop forever (Android `MAX_RESTART_ATTEMPTS`).
/// * Exponential backoff `1s * 2^attempt` (Android `1000ms * (1 << attempt)`).
/// * Sustained health resets both the strike counter and the restart-attempt
///   counter (Android resets `unhealthyTicks`/`restartAttempts` on `ProbeResult.OK`).
///
/// ## Lifecycle
///
/// The in-process runtime is suspended when the app is backgrounded, so polling
/// only runs in the foreground. The watchdog pauses on background, re-probes on
/// foreground, and tears down on terminate. It is created once from
/// `AppDelegate.didFinishLaunchingWithOptions` via `bootstrap()` and otherwise
/// owns its own observers.
///
/// All mutable state is touched on the main thread (WebKit requires it); every
/// optional is handled — there are no force-unwraps that can crash the host app.
final class AgentWatchdog {
    static let shared = AgentWatchdog()

    // MARK: - Contract (NotificationCenter)

    /// Posted by the runtime layer when a *local* agent has started. Optional
    /// fast-arm signal — the watchdog also self-arms by discovering a running
    /// local agent through its health probe, so this is an accelerator, not a
    /// requirement.
    static let didStartNotification = Notification.Name("ElizaLocalAgentDidStart")

    /// Posted by the runtime layer when the in-process agent exits/crashes (the
    /// native mirror of the Capacitor `eliza:runtime-exit` event). Optional
    /// fast-path crash signal; the health probe detects the same condition.
    static let didExitNotification = Notification.Name("ElizaLocalAgentDidExit")

    /// Posted by the runtime layer when the local agent is intentionally stopped
    /// (e.g. the user switched to cloud mode). Disarms the watchdog.
    static let didStopNotification = Notification.Name("ElizaLocalAgentDidStop")

    /// Posted BY the watchdog to request a bounded restart. The runtime owner
    /// honors it by re-running the existing `ElizaBunRuntime.start(...)`.
    static let restartRequestedNotification = Notification.Name("ElizaLocalAgentRestartRequested")

    // MARK: - Tunables (mirror Android ElizaAgentService)

    /// Foreground health-poll cadence. Android uses a 10-minute interval only
    /// because a single chat turn can block its event loop for tens of minutes on
    /// an emulated CPU; iOS runs generation on a separate work queue and reports
    /// liveness via `getStatus().ready` (true while busy), so a few-second cadence
    /// is correct and never false-positives on a busy model.
    private static let healthPollInterval: TimeInterval = 5

    /// Consecutive unhealthy polls before requesting a restart (`HEALTH_FAIL_STRIKES`).
    private static let healthFailStrikes = 3

    /// Bounded restart attempts within `restartAttemptWindow` (`MAX_RESTART_ATTEMPTS`).
    private static let maxRestartAttempts = 5

    /// Base backoff; attempt N waits `baseRestartBackoff * 2^N` (Android `1000ms * (1 << N)`).
    private static let baseRestartBackoff: TimeInterval = 1

    /// Cold-boot grace before a not-yet-ready runtime counts as a crash. Applies
    /// only before the first healthy sighting, so a slow first model load doesn't
    /// trigger a restart loop (cf. Android's startup probe grace).
    private static let startupGrace: TimeInterval = 60

    /// Rolling window over which restart attempts accumulate. Crashes spread wider
    /// than this reset the attempt counter so the watchdog recovers after a long
    /// healthy stretch even if it once hit the cap.
    private static let restartAttemptWindow: TimeInterval = 300

    /// Delay before the post-launch / post-foreground discovery probe.
    private static let discoveryProbeDelay: TimeInterval = 3

    // MARK: - State (main thread only)

    private var bootstrapped = false
    private var armed = false
    private var foreground = true
    private var hasBeenHealthy = false
    private var unhealthyStrikes = 0
    private var restartAttempts = 0
    private var armedAt: Date?
    private var lastRestartAt: Date?
    private var pollTimer: Timer?
    private var probing = false
    private var restartPending = false

    private init() {}

    // MARK: - Bootstrap

    /// Registers observers and schedules the first discovery probe. Idempotent;
    /// safe to call once from `AppDelegate`. The watchdog stays dormant (no
    /// polling) until it observes — or discovers — a running local agent.
    func bootstrap() {
        runOnMain { [weak self] in
            guard let self, !self.bootstrapped else { return }
            self.bootstrapped = true

            let center = NotificationCenter.default
            center.addObserver(
                self,
                selector: #selector(self.handleDidStart),
                name: Self.didStartNotification,
                object: nil
            )
            center.addObserver(
                self,
                selector: #selector(self.handleDidExit),
                name: Self.didExitNotification,
                object: nil
            )
            center.addObserver(
                self,
                selector: #selector(self.handleDidStop),
                name: Self.didStopNotification,
                object: nil
            )
            center.addObserver(
                self,
                selector: #selector(self.handleDidBecomeActive),
                name: UIApplication.didBecomeActiveNotification,
                object: nil
            )
            center.addObserver(
                self,
                selector: #selector(self.handleDidEnterBackground),
                name: UIApplication.didEnterBackgroundNotification,
                object: nil
            )
            center.addObserver(
                self,
                selector: #selector(self.handleWillTerminate),
                name: UIApplication.willTerminateNotification,
                object: nil
            )

            self.foreground = UIApplication.shared.applicationState != .background
            self.log("bootstrapped (dormant until a local agent starts)")
            self.scheduleDiscoveryProbe()
        }
    }

    // MARK: - Lifecycle observers

    @objc private func handleDidBecomeActive() {
        runOnMain { [weak self] in
            guard let self else { return }
            self.foreground = true
            if self.armed {
                self.startPolling()
            } else {
                self.scheduleDiscoveryProbe()
            }
        }
    }

    @objc private func handleDidEnterBackground() {
        runOnMain { [weak self] in
            guard let self else { return }
            self.foreground = false
            // The in-process runtime is suspended in the background; polling it is
            // pointless and would burn the OS background budget.
            self.stopPolling()
        }
    }

    @objc private func handleWillTerminate() {
        runOnMain { [weak self] in
            guard let self else { return }
            self.stopPolling()
            self.armed = false
        }
    }

    // MARK: - Contract observers

    @objc private func handleDidStart() {
        runOnMain { [weak self] in self?.arm(reason: "ElizaLocalAgentDidStart") }
    }

    @objc private func handleDidStop() {
        runOnMain { [weak self] in self?.disarm(reason: "ElizaLocalAgentDidStop") }
    }

    @objc private func handleDidExit() {
        runOnMain { [weak self] in
            guard let self, self.armed else { return }
            self.log("local agent reported exit — requesting restart")
            self.unhealthyStrikes = 0
            self.requestRestart()
        }
    }

    // MARK: - Arm / disarm

    private func arm(reason: String) {
        guard !armed else { return }
        armed = true
        armedAt = Date()
        hasBeenHealthy = false
        unhealthyStrikes = 0
        restartAttempts = 0
        log("armed (\(reason)) — watching local agent health")
        if foreground {
            startPolling()
        }
    }

    private func disarm(reason: String) {
        guard armed else { return }
        armed = false
        armedAt = nil
        unhealthyStrikes = 0
        restartPending = false
        stopPolling()
        log("disarmed (\(reason)) — no local agent to watch")
    }

    // MARK: - Polling

    private func startPolling() {
        guard armed, foreground else { return }
        pollTimer?.invalidate()
        let timer = Timer.scheduledTimer(
            withTimeInterval: Self.healthPollInterval,
            repeats: true
        ) { [weak self] _ in
            self?.poll()
        }
        pollTimer = timer
        // Probe immediately so we don't wait a full interval after arming.
        poll()
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func scheduleDiscoveryProbe() {
        guard !armed, foreground else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.discoveryProbeDelay) { [weak self] in
            guard let self, !self.armed, self.foreground else { return }
            self.probe { [weak self] reading in
                guard let self else { return }
                guard let reading else { return } // bridge not ready yet; a later lifecycle event retries
                if reading.local {
                    self.arm(reason: "discovered running local agent")
                }
            }
        }
    }

    private func poll() {
        guard armed, foreground, !restartPending else { return }
        probe { [weak self] reading in
            self?.evaluate(reading)
        }
    }

    private func evaluate(_ reading: HealthReading?) {
        guard armed else { return }

        // A failed/unavailable probe (transient WebView state) is NOT a crash —
        // an in-process runtime crash leaves the WebView alive and getStatus
        // answers `ready: false`. Don't strike on an inconclusive read.
        guard let reading else {
            log("health probe inconclusive (bridge unavailable) — no strike")
            return
        }

        if !reading.local {
            // Switched to cloud/remote, or the local runtime plugin went away.
            disarm(reason: "runtime mode is no longer local")
            return
        }

        if reading.ready {
            recordHealthy()
            return
        }

        // Not ready. Hold fire during the cold-boot grace before the first
        // healthy sighting so a slow first model load doesn't restart-loop.
        if !hasBeenHealthy, let armedAt, Date().timeIntervalSince(armedAt) < Self.startupGrace {
            log("local agent not ready yet (within \(Int(Self.startupGrace))s cold-boot grace) — no strike")
            return
        }

        recordUnhealthy()
    }

    private func recordHealthy() {
        if unhealthyStrikes > 0 || restartAttempts > 0 {
            log("local agent health restored")
        }
        hasBeenHealthy = true
        unhealthyStrikes = 0
        restartAttempts = 0 // sustained health resets the bounded restart budget
    }

    private func recordUnhealthy() {
        unhealthyStrikes += 1
        log("local agent health probe failed (\(unhealthyStrikes)/\(Self.healthFailStrikes) consecutive)")
        if unhealthyStrikes >= Self.healthFailStrikes {
            unhealthyStrikes = 0
            requestRestart()
        }
    }

    // MARK: - Restart

    private func requestRestart() {
        guard armed, !restartPending else { return }

        // Reset the attempt budget when crashes are spread wider than the window
        // — a single crash after a long healthy stretch shouldn't inherit an old
        // exhausted counter.
        if let lastRestartAt, Date().timeIntervalSince(lastRestartAt) > Self.restartAttemptWindow {
            restartAttempts = 0
        }

        if restartAttempts >= Self.maxRestartAttempts {
            log("local agent failed \(restartAttempts) restart attempts — giving up; stopping watchdog polling")
            stopPolling()
            return
        }

        let attempt = restartAttempts + 1
        let backoff = Self.baseRestartBackoff * pow(2, Double(restartAttempts))
        restartAttempts = attempt
        lastRestartAt = Date()
        restartPending = true
        log("requesting local agent restart in \(String(format: "%.0f", backoff))s (attempt \(attempt)/\(Self.maxRestartAttempts))")

        DispatchQueue.main.asyncAfter(deadline: .now() + backoff) { [weak self] in
            guard let self else { return }
            self.restartPending = false
            guard self.armed else { return }
            self.emitRestartRequest(attempt: attempt)
            // Keep polling; the next probe confirms recovery (and resets the
            // attempt budget via recordHealthy) or escalates the next strike.
            if self.foreground, self.pollTimer == nil {
                self.startPolling()
            }
        }
    }

    /// Signals the existing runtime-start owner to re-initialize the in-process
    /// agent. Two channels so either a native observer or the WebView/renderer can
    /// honor it; both are best-effort and neither fabricates a start config.
    private func emitRestartRequest(attempt: Int) {
        NotificationCenter.default.post(
            name: Self.restartRequestedNotification,
            object: nil,
            userInfo: ["attempt": attempt, "source": "ios-watchdog"]
        )
        let js = """
        try {
          window.dispatchEvent(new CustomEvent('eliza:local-agent-restart-requested', {
            detail: { source: 'ios-watchdog', attempt: \(attempt) }
          }));
        } catch (e) {}
        """
        guard let webView = bridgeWebView() else {
            log("restart request posted (no WebView to dispatch DOM event)")
            return
        }
        webView.evaluateJavaScript(js, completionHandler: nil)
        log("restart request emitted (attempt \(attempt))")
    }

    // MARK: - Health probe (through the Capacitor bridge)

    private struct HealthReading {
        let local: Bool
        let ready: Bool
    }

    /// Runs the probe script in the page's content world and maps the result to a
    /// `HealthReading`. `nil` means the probe couldn't run (no WebView / JS error)
    /// — treated as inconclusive, never as a crash.
    private func probe(_ completion: @escaping (HealthReading?) -> Void) {
        guard !probing else {
            completion(nil)
            return
        }
        guard let webView = bridgeWebView() else {
            completion(nil)
            return
        }
        probing = true
        webView.callAsyncJavaScript(
            Self.probeScript,
            arguments: [:],
            in: nil,
            in: .page
        ) { [weak self] result in
            guard let self else { return }
            self.probing = false
            switch result {
            case .success(let value):
                if let dict = value as? [String: Any] {
                    ElizaStartupTrace.append(
                        source: "watchdog",
                        stage: "probe",
                        detail: [
                            "mode": dict["mode"] ?? NSNull(),
                            "present": dict["present"] ?? false,
                            "local": dict["local"] ?? false,
                            "ready": dict["ready"] ?? false,
                            "engine": dict["engine"] ?? NSNull(),
                        ]
                    )
                }
                completion(self.parseReading(value))
            case .failure(let error):
                self.log("health probe error: \(error.localizedDescription)")
                completion(nil)
            }
        }
    }

    private func parseReading(_ value: Any?) -> HealthReading? {
        guard let dict = value as? [String: Any] else { return nil }
        return HealthReading(
            local: Self.boolValue(dict["local"]),
            ready: Self.boolValue(dict["ready"])
        )
    }

    private static func boolValue(_ value: Any?) -> Bool {
        if let bool = value as? Bool { return bool }
        if let number = value as? NSNumber { return number.boolValue }
        return false
    }

    /// Reads the renderer's runtime mode (its own `localStorage` source of truth)
    /// and the live `ElizaBunRuntime` plugin status. `local` is false for
    /// pure cloud mode (or a missing plugin) so the watchdog no-ops there;
    /// `ready` reflects the in-process engine being up.
    private static let probeScript = """
    var mode = null;
    try { mode = window.localStorage.getItem('eliza:mobile-runtime-mode'); } catch (e) {}
    var cap = window.Capacitor;
    var rt = (cap && cap.Plugins) ? cap.Plugins.ElizaBunRuntime : null;
    var present = !!(rt && typeof rt.getStatus === 'function');
    var isPureRemote = (mode === 'cloud');
    var local = present && !isPureRemote;
    var ready = false;
    var engine = null;
    if (local) {
      try {
        var status = await rt.getStatus();
        ready = !!(status && status.ready);
        engine = (status && status.engine) ? String(status.engine) : null;
      } catch (e) { ready = false; }
    }
    return { mode: mode, present: present, local: local, ready: ready, engine: engine };
    """

    // MARK: - WebView discovery

    private func bridgeWebView() -> WKWebView? {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                if let webView = findBridgeWebView(in: window.rootViewController) {
                    return webView
                }
            }
        }
        return nil
    }

    private func findBridgeWebView(in viewController: UIViewController?) -> WKWebView? {
        guard let viewController else { return nil }
        if let bridgeVC = viewController as? CAPBridgeViewController,
           let webView = bridgeVC.webView {
            return webView
        }
        if let presented = viewController.presentedViewController,
           let webView = findBridgeWebView(in: presented) {
            return webView
        }
        for child in viewController.children {
            if let webView = findBridgeWebView(in: child) {
                return webView
            }
        }
        return nil
    }

    // MARK: - Helpers

    private func runOnMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }

    private func log(_ message: String) {
        NSLog("%@", "[AgentWatchdog] \(message)")
        // Mirror every watchdog state transition into the persistent boot
        // trace so unattended launches are diagnosable without a console.
        ElizaStartupTrace.append(
            source: "watchdog",
            stage: "state",
            detail: ["message": message]
        )
    }
}
