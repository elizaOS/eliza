import Foundation

public enum RuntimeStatus: Equatable, Sendable {
    case stopped
    case starting
    case running(apiBase: URL)
    case failed(message: String)

    public var title: String {
        switch self {
        case .stopped:
            "Stopped"
        case .starting:
            "Starting"
        case .running:
            "Running"
        case .failed:
            "Failed"
        }
    }

    public var detail: String {
        switch self {
        case .stopped:
            "No local runtime process is active."
        case .starting:
            "The local runtime process is starting."
        case let .running(apiBase):
            apiBase.absoluteString
        case let .failed(message):
            message
        }
    }

    public var systemImage: String {
        switch self {
        case .stopped:
            "stop.circle"
        case .starting:
            "clock"
        case .running:
            "checkmark.circle"
        case .failed:
            "exclamationmark.triangle"
        }
    }

    public var isRunning: Bool {
        if case .running = self {
            return true
        }
        return false
    }
}
