import Foundation
import JavaScriptCore
import os.log

/// Implements `log(level, message)` from `BRIDGE_CONTRACT.md` via `os_log`.
public final class LogBridge {
    private let logger: OSLog

    public init(subsystem: String = "ai.eliza.bun.runtime", category: String = "agent") {
        self.logger = OSLog(subsystem: subsystem, category: category)
    }

    public func install(into ctx: JSContext) {
        ctx.installBridgeFunction(name: "log") { args in
            guard args.count >= 2,
                  let level = args[0].toString(),
                  let message = args[1].toString() else {
                return NSNull()
            }
            self.log(level: level, message: message)
            return NSNull()
        }
    }

    private func log(level: String, message: String) {
        let type: OSLogType
        switch level.lowercased() {
        case "debug": type = .debug
        case "info": type = .info
        case "warn", "warning": type = .default
        case "error": type = .error
        default: type = .default
        }
        os_log("%{public}@", log: logger, type: type, message)
    }
}
