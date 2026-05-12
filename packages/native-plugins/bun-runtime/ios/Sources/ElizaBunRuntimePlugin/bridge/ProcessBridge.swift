import Foundation
import JavaScriptCore

/// Implements `now_ns`, `argv`, `env_*`, `exit` from `BRIDGE_CONTRACT.md`.
public final class ProcessBridge {
    private var env: [String: String] = [:]
    private var argv: [String] = ["bun", "public/agent/agent-bundle.js"]
    /// Snapshot of the monotonic clock origin for `now_ns`.
    private let monotonicEpoch: UInt64
    private weak var owner: ElizaBunRuntime?

    public init(initialArgv: [String], initialEnv: [String: String], owner: ElizaBunRuntime) {
        var merged = ProcessInfo.processInfo.environment
        for (k, v) in initialEnv {
            merged[k] = v
        }
        self.env = merged
        if !initialArgv.isEmpty {
            self.argv = initialArgv
        }
        self.monotonicEpoch = Self.machRaw()
        self.owner = owner
    }

    public func install(into ctx: JSContext) {
        ctx.installBridgeFunction(name: "now_ns") { _ in
            return NSNumber(value: Self.elapsedNanos(since: self.monotonicEpoch))
        }

        ctx.installBridgeFunction(name: "argv") { _ in
            return self.argv
        }

        ctx.installBridgeFunction(name: "env_get") { args in
            guard let key = args.first?.toString() else { return NSNull() }
            return self.env[key] ?? NSNull()
        }

        ctx.installBridgeFunction(name: "env_set") { args in
            guard args.count >= 2,
                  let key = args[0].toString(),
                  let value = args[1].toString() else {
                return NSNull()
            }
            self.env[key] = value
            return NSNull()
        }

        ctx.installBridgeFunction(name: "env_keys") { _ in
            return Array(self.env.keys)
        }

        ctx.installBridgeFunction(name: "exit") { args in
            let code = args.first?.toNumber()?.intValue ?? 0
            NSLog("[ElizaBunRuntime] agent called exit(\(code))")
            // We do not actually call `Foundation.exit()` here. Killing the
            // host process from the agent is rude. Instead, tear down the
            // JSContext and signal the plugin so it surfaces a stopped state
            // to the React UI.
            self.owner?.handleAgentExit(code: code)
            return NSNull()
        }
    }

    // MARK: - Monotonic clock

    private static func machRaw() -> UInt64 {
        // mach_absolute_time returns ticks. Convert to nanoseconds via
        // mach_timebase_info.
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        let ticks = mach_absolute_time()
        return ticks &* UInt64(info.numer) / UInt64(max(info.denom, 1))
    }

    private static func elapsedNanos(since epoch: UInt64) -> Double {
        let now = machRaw()
        return Double(now &- epoch)
    }
}
