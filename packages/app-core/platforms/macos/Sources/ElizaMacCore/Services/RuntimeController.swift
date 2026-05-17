import Foundation
import OSLog

public enum RuntimeControllerError: Error, Equatable, LocalizedError {
    case alreadyRunning
    case disabled
    case missingRepository(String)
    case preflightFailed(String)

    public var errorDescription: String? {
        switch self {
        case .alreadyRunning:
            "Runtime is already running."
        case .disabled:
            "Runtime launch mode is disabled."
        case let .missingRepository(path):
            "No elizaOS repository was found at \(path)."
        case let .preflightFailed(message):
            message
        }
    }
}

@MainActor
public final class RuntimeController {
    public private(set) var status: RuntimeStatus
    public private(set) var recentOutput: [String]

    private var process: Process?
    private var outputPipe: Pipe?
    private var errorPipe: Pipe?
    private let logger: Logger

    public init(
        status: RuntimeStatus = .stopped,
        logger: Logger = Logger(subsystem: "ai.eliza.mac", category: "RuntimeController")
    ) {
        self.status = status
        self.recentOutput = []
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
        clearPipes()
        status = .stopped
        logger.info("[RuntimeController] Runtime stopped")
    }

    private func startLocalRuntime(configuration: RuntimeConfiguration) throws {
        guard ElizaRepositoryResolver.resolve(
            startingAt: URL(fileURLWithPath: configuration.repositoryRoot, isDirectory: true)
        ) != nil else {
            throw RuntimeControllerError.missingRepository(configuration.repositoryRoot)
        }

        try ensureRuntimePreflight(configuration: configuration)

        let command = RuntimeCommandBuilder.startCommand(configuration: configuration)
        let nextProcess = Process()
        nextProcess.executableURL = URL(fileURLWithPath: command.executable)
        nextProcess.arguments = command.arguments
        nextProcess.currentDirectoryURL = URL(fileURLWithPath: command.workingDirectory, isDirectory: true)

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        nextProcess.standardOutput = outputPipe
        nextProcess.standardError = errorPipe
        self.outputPipe = outputPipe
        self.errorPipe = errorPipe
        recentOutput = []
        observe(pipe: outputPipe, stream: "stdout")
        observe(pipe: errorPipe, stream: "stderr")

        var environment = ProcessInfo.processInfo.environment
        for (key, value) in command.environment {
            environment[key] = value
        }
        nextProcess.environment = environment

        status = .starting
        process = nextProcess
        nextProcess.terminationHandler = { [weak self, weak nextProcess] process in
            Task { @MainActor in
                guard let self, self.process === nextProcess else {
                    return
                }
                let exitCode = process.terminationStatus
                self.process = nil
                self.clearPipes()
                if exitCode == 0 {
                    self.status = .stopped
                    self.logger.info("[RuntimeController] Runtime process exited")
                } else {
                    let message = self.processExitMessage(exitCode: exitCode)
                    self.status = .failed(message: message)
                    self.logger.error("[RuntimeController] Runtime process failed exitCode=\(exitCode, privacy: .public)")
                }
            }
        }

        do {
            try nextProcess.run()
        } catch {
            process = nil
            clearPipes()
            status = .failed(message: error.localizedDescription)
            throw error
        }

        logger.info("[RuntimeController] Launched runtime pid=\(nextProcess.processIdentifier, privacy: .public)")
    }

    private func ensureRuntimePreflight(configuration: RuntimeConfiguration) throws {
        let root = URL(fileURLWithPath: configuration.repositoryRoot, isDirectory: true)
        let requiredFiles = [
            root.appendingPathComponent("packages/shared/src/i18n/generated/validation-keyword-data.ts"),
            root.appendingPathComponent("packages/shared/src/i18n/generated/validation-keyword-data.js"),
            root.appendingPathComponent("packages/core/src/i18n/generated/validation-keyword-data.ts")
        ]

        guard requiredFiles.contains(where: { !FileManager.default.fileExists(atPath: $0.path) }) else {
            return
        }

        let preflight = Process()
        preflight.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        preflight.arguments = ["node", "packages/shared/scripts/generate-keywords.mjs", "--target", "ts"]
        preflight.currentDirectoryURL = root

        let outputPipe = Pipe()
        let errorPipe = Pipe()
        preflight.standardOutput = outputPipe
        preflight.standardError = errorPipe

        do {
            try preflight.run()
            preflight.waitUntilExit()
        } catch {
            throw RuntimeControllerError.preflightFailed("Runtime preflight failed to launch: \(error.localizedDescription)")
        }

        let output = Self.pipeText(outputPipe)
        let error = Self.pipeText(errorPipe)
        recordOutput(output, stream: "preflight")
        recordOutput(error, stream: "preflight")

        guard preflight.terminationStatus == 0 else {
            let message = [output, error]
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .joined(separator: " ")
            throw RuntimeControllerError.preflightFailed("Runtime preflight exited with code \(preflight.terminationStatus): \(message)")
        }
    }

    private func observe(pipe: Pipe, stream: String) {
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else {
                return
            }
            Task { @MainActor in
                self?.recordOutput(text, stream: stream)
            }
        }
    }

    private func recordOutput(_ text: String, stream: String) {
        let lines = text
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        for line in lines {
            recentOutput.append("[\(stream)] \(line)")
        }
        recentOutput = Array(recentOutput.suffix(80))
    }

    private func clearPipes() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        errorPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
        errorPipe = nil
    }

    private func processExitMessage(exitCode: Int32) -> String {
        let tail = recentOutput.suffix(8).joined(separator: " ")
        if tail.isEmpty {
            return "Runtime process exited with code \(exitCode)."
        }
        return "Runtime process exited with code \(exitCode): \(tail)"
    }

    private static func pipeText(_ pipe: Pipe) -> String {
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8) ?? ""
    }
}
