import Foundation

public struct RuntimeConfiguration: Codable, Equatable, Sendable {
    public var repositoryRoot: String
    public var apiPort: Int
    public var uiPort: Int
    public var launchMode: RuntimeLaunchMode
    public var externalAPIBaseURL: URL?
    public var userName: String

    public init(
        repositoryRoot: String,
        apiPort: Int = 31337,
        uiPort: Int = 2138,
        launchMode: RuntimeLaunchMode = .local,
        externalAPIBaseURL: URL? = nil,
        userName: String = ""
    ) {
        self.repositoryRoot = repositoryRoot
        self.apiPort = apiPort
        self.uiPort = uiPort
        self.launchMode = launchMode
        self.externalAPIBaseURL = externalAPIBaseURL
        self.userName = UserProfile.normalizedName(userName)
    }

    public static func defaultConfiguration(
        repositoryRoot: String? = nil,
        arguments: [String] = CommandLine.arguments,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> RuntimeConfiguration {
        RuntimeConfiguration(
            repositoryRoot: repositoryRoot
                ?? launchRepositoryRoot(arguments: arguments, environment: environment)
                ?? ElizaRepositoryResolver.resolve()?.path
                ?? FileManager.default.currentDirectoryPath
        )
    }

    public var apiBaseURL: URL {
        if let externalAPIBaseURL {
            return externalAPIBaseURL
        }
        return Self.localURL(port: apiPort)
    }

    public var rendererURL: URL {
        Self.localURL(port: uiPort)
    }

    private static func localURL(port: Int) -> URL {
        guard (1...65535).contains(port) else {
            preconditionFailure("Invalid localhost port: \(port)")
        }
        guard let url = URL(string: "http://127.0.0.1:\(port)") else {
            preconditionFailure("Invalid localhost URL for port: \(port)")
        }
        return url
    }

    private static func launchRepositoryRoot(arguments: [String], environment: [String: String]) -> String? {
        if let argumentValue = value(after: "--eliza-repository-root", in: arguments) {
            return argumentValue
        }

        if let argumentValue = value(after: "--repo-root", in: arguments) {
            return argumentValue
        }

        return environment["ELIZA_REPOSITORY_ROOT"]
    }

    private static func value(after flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag) else {
            return nil
        }

        let valueIndex = arguments.index(after: index)
        guard valueIndex < arguments.endIndex else {
            return nil
        }

        let value = arguments[valueIndex].trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}
