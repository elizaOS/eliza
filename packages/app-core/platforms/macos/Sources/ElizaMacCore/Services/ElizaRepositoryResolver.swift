import Foundation

public enum ElizaRepositoryResolver {
    public static func resolve(
        startingAt startURL: URL? = nil,
        fileManager: FileManager = .default
    ) -> URL? {
        let initialURL = startURL ?? URL(fileURLWithPath: fileManager.currentDirectoryPath, isDirectory: true)
        var currentURL = (initialURL.hasDirectoryPath ? initialURL : initialURL.deletingLastPathComponent()).standardizedFileURL

        while true {
            if isElizaRoot(currentURL, fileManager: fileManager) {
                return currentURL
            }

            let parentURL = currentURL.deletingLastPathComponent().standardizedFileURL
            if parentURL.path == currentURL.path {
                return nil
            }
            currentURL = parentURL
        }
    }

    private static func isElizaRoot(_ url: URL, fileManager: FileManager) -> Bool {
        fileManager.fileExists(atPath: url.appendingPathComponent("package.json").path)
            && fileManager.fileExists(atPath: url.appendingPathComponent("packages/app-core/package.json").path)
            && fileManager.fileExists(atPath: url.appendingPathComponent("packages/agent/package.json").path)
    }
}
