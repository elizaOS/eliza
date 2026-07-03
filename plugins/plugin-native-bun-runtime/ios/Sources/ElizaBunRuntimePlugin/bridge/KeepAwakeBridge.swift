import Foundation
#if canImport(UIKit)
    import UIKit
#endif

/// Reference-counted holder for the iOS idle timer, shared by both runtime
/// engines.
///
/// While a large on-device model download (or load) is in flight, the agent
/// asks the app to disable the iOS idle timer so the screen does not auto-lock
/// and suspend the embedded runtime mid-transfer. That suspension is what
/// otherwise stalls the ~5 GB Eliza-1 model download at "Loading eliza-1-2B…"
/// (#11841): the download streams through the in-process runtime, which iOS
/// freezes the instant the device auto-locks.
///
/// Reference-counted so overlapping holders (e.g. a text + a vision download)
/// compose; the idle timer is only re-enabled once the last holder clears.
/// This does NOT cover a *manual* lock / backgrounding — that needs the native
/// background `URLSession` download (#11841 primary fix) — but it removes the
/// far more common auto-lock stall for a foregrounded download.
///
/// This core type carries no JavaScriptCore dependency so it compiles into the
/// full-Bun engine build (which omits JavaScriptCore). The `keep_awake_set`
/// entry points are:
///   - full-Bun engine: the `host_call` dispatch in `FullBunEngineHost`
///     (`KeepAwakeBridge.shared.setEnabled(_:)`);
///   - JSContext compat: the `install(into:)` extension (compat-only file).
public final class KeepAwakeBridge {
    /// Process-wide holder shared by both runtime engines. A device runs exactly
    /// one engine (full-Bun *or* JSContext compat), but sharing one ref-counted
    /// holder keeps the idle-timer state single-sourced either way.
    public static let shared = KeepAwakeBridge()

    private let lock = NSLock()
    private var holders = 0

    public init() {}

    /// Acquire (`true`) or release (`false`) an idle-timer hold. This is the
    /// entry point the full-Bun `host_call` dispatch (`FullBunEngineHost`) uses;
    /// the JSContext compat path installs `keep_awake_set` via the separate
    /// `KeepAwakeBridge+JSContext.swift` extension (which funnels into
    /// `setEnabled`). Keeping this core type JavaScriptCore-free lets it compile
    /// into the full-Bun engine build, whose podspec omits JavaScriptCore.
    public func setEnabled(_ enabled: Bool) {
        setHolder(enabled)
    }

    /// Force-release the idle-timer hold (call when the runtime tears down so a
    /// stuck holder never pins the screen awake past the runtime's lifetime).
    public func reset() {
        lock.lock()
        holders = 0
        lock.unlock()
        applyIdleTimer(disabled: false)
    }

    func setHolder(_ enabled: Bool) {
        lock.lock()
        holders = max(0, holders + (enabled ? 1 : -1))
        let disabled = holders > 0
        lock.unlock()
        applyIdleTimer(disabled: disabled)
    }

    private func applyIdleTimer(disabled: Bool) {
        #if canImport(UIKit)
            DispatchQueue.main.async {
                UIApplication.shared.isIdleTimerDisabled = disabled
            }
        #endif
    }
}
