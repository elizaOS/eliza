import Foundation

enum ElizaStartupTrace {
    static let currentId: String = {
        let millis = Int(Date().timeIntervalSince1970 * 1000)
        return "ios-\(millis)-\(UUID().uuidString.lowercased())"
    }()

    static var documentStartScript: String {
        "window.__ELIZA_STARTUP_TRACE_ID__ = \"\(currentId)\";"
    }
}
