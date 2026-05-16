import Foundation
import OSLog

public enum RuntimeControllerError: Error, Equatable, LocalizedError {
    case alreadyRunning
    case disabled
    case missingRepository(String)

    public var errorDescription: String? {
        switch self {
        case .alreadyRunning:
            "Runtime is already running."
        case .disabled:
            "Runtime launch mode is disabled."
        case let .missingRepository(path):
            "No elizaOS repository was found at \(path)."
        }
    }
}

@MainActor
public final class RuntimeController {
    public private(set) var status: RuntimeStatus

    private var process: Process?
    private let logger: Logger

    public init(
        status: RuntimeStatus = .stopped,
        logger: Logger = Logger(subsystem: "ai.eliza.mac", category: "RuntimeController")
    ) {
        self.status = status
        self.logger = logger
    }

    public func start(configuration: RuntimeConfiguration) throws {
        guard process == nil else {
            throw RuntimeControllerError.alreadyRunning
        }

        switch configuration.launchMode {
        case .local:
            try startLocalRuntime(configuration: configuration)
        case .external:
            status = .running(apiBase: configuration.apiBaseURL)
            logger.info("[RuntimeController] Using external runtime \(configuration.apiBaseURL.absoluteString, privacy: .public)")
        case .disabled:
            throw RuntimeControllerError.disabled
        }
    }

    public func stop() {
        process?.terminate()
        process = nil
        status = .stopped
        logger.info("[RuntimeController] Runtime stopped")
    }

    private func startLocalRuntime(configuration: RuntimeConfiguration) throws {
        guard ElizaRepositoryResolver.resolve(
            startingAt: URL(fileURLWithPath: configuration.repositoryRoot, isDirectory: true)
        ) != nil else {
            throw RuntimeControllerError.missingRepository(configuration.repositoryRoot)
        }

        let command = RuntimeCommandBuilder.startCommand(configuration: configuration)
        let nextProcess = Process()
        nextProcess.executableURL = URL(fileURLWithPath: command.executable)
        nextProcess.arguments = command.arguments
        nextProcess.currentDirectoryURL = URL(fileURLWithPath: command.workingDirectory, isDirectory: true)

        var environment = ProcessInfo.processInfo.environment
        for (key, value) in command.environment {
            environment[key] = value
        }
        nextProcess.environment = environment

        status = .starting
        try nextProcess.run()
        process = nextProcess
        status = .running(apiBase: configuration.apiBaseURL)
        logger.info("[RuntimeController] Started runtime pid=\(nextProcess.processIdentifier, privacy: .public)")
    }
}
