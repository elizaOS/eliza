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

    public static func defaultConfiguration(repositoryRoot: String? = nil) -> RuntimeConfiguration {
        RuntimeConfiguration(
            repositoryRoot: repositoryRoot
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
}
