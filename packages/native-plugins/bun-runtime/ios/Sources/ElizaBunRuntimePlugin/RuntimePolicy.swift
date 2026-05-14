import Foundation

public struct RuntimePolicy {
    public let appStoreCompliantLocalRuntime: Bool
    private let paths: SandboxPaths

    public init(paths: SandboxPaths) {
        self.paths = paths
        #if ELIZA_IOS_APP_STORE_COMPLIANT_LOCAL_RUNTIME
        self.appStoreCompliantLocalRuntime = true
        #else
        self.appStoreCompliantLocalRuntime = false
        #endif
    }

    public func allowsFilesystemPath(_ path: String, operation: FilesystemOperation) -> Bool {
        guard appStoreCompliantLocalRuntime else { return true }
        guard path.hasPrefix("/") else { return false }

        let url = URL(fileURLWithPath: path).standardizedFileURL
        let readRoots = [
            paths.appSupport,
            paths.documents,
            paths.caches,
            paths.tmp,
            paths.bundle,
        ]
        let writeRoots = [
            paths.appSupport,
            paths.documents,
            paths.caches,
            paths.tmp,
        ]
        let roots = operation == .read ? readRoots : writeRoots
        return roots.contains { Self.isPath(url, inside: $0) }
    }

    public func filteredEnvironment(
        processEnvironment: [String: String],
        overrides: [String: String]
    ) -> [String: String] {
        guard appStoreCompliantLocalRuntime else {
            var merged = processEnvironment
            for (key, value) in overrides {
                merged[key] = value
            }
            return merged
        }

        var filtered: [String: String] = [:]
        for (key, value) in overrides {
            if Self.isAllowedEnvironmentKey(key) {
                filtered[key] = value
            }
        }
        filtered["HOME"] = paths.appSupport.path
        filtered["TMPDIR"] = paths.tmp.path
        filtered["ELIZA_IOS_APP_STORE_LOCAL_RUNTIME"] = "1"
        filtered["ELIZA_NO_DOWNLOADED_EXECUTABLE_CODE"] = "1"
        return filtered
    }

    public func allowsEnvironmentMutation(key: String) -> Bool {
        guard appStoreCompliantLocalRuntime else { return true }
        return Self.isAllowedEnvironmentKey(key)
    }

    private static func isPath(_ path: URL, inside root: URL) -> Bool {
        let rootPath = root.standardizedFileURL.path
        let candidate = path.standardizedFileURL.path
        return candidate == rootPath || candidate.hasPrefix(rootPath + "/")
    }

    private static func isAllowedEnvironmentKey(_ key: String) -> Bool {
        if key.hasPrefix("DYLD_") || key.hasPrefix("LD_") || key.hasPrefix("__XPC") {
            return false
        }
        if key == "PATH" || key == "SHELL" {
            return false
        }
        return key.hasPrefix("ELIZA_") ||
            key.hasPrefix("VITE_ELIZA_") ||
            key.hasPrefix("MOBILE_") ||
            key.hasPrefix("PGLITE_") ||
            key == "HOME" ||
            key == "TMPDIR" ||
            key == "LOG_LEVEL"
    }
}

public enum FilesystemOperation {
    case read
    case write
}
