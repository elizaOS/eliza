import Foundation

public enum BunExecutableResolver {
    public static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) -> String {
        for candidate in candidates(environment: environment) {
            if fileManager.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return "/usr/bin/env"
    }

    private static func candidates(environment: [String: String]) -> [String] {
        var paths: [String] = []

        if let bunInstall = environment["BUN_INSTALL"], !bunInstall.isEmpty {
            paths.append("\(bunInstall)/bin/bun")
        }

        if let home = environment["HOME"], !home.isEmpty {
            paths.append("\(home)/.bun/bin/bun")
        }

        paths.append("/opt/homebrew/bin/bun")
        paths.append("/usr/local/bin/bun")

        return paths
    }
}
