import Foundation

/// Resolved sandbox directories handed to bridge modules at install time.
/// Each path is absolute and stable for the lifetime of the process.
public struct SandboxPaths {
    public let appSupport: URL
    public let documents: URL
    public let caches: URL
    public let tmp: URL
    public let bundle: URL

    public init(appBundle: Bundle = .main, brand: String = "Eliza") {
        let fm = FileManager.default
        let supportRoot = (try? fm.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")

        let appSupportURL = supportRoot.appendingPathComponent(brand, isDirectory: true)
        if !fm.fileExists(atPath: appSupportURL.path) {
            try? fm.createDirectory(at: appSupportURL, withIntermediateDirectories: true)
        }
        self.appSupport = appSupportURL

        let docs = (try? fm.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Documents")
        self.documents = docs

        let caches = (try? fm.url(
            for: .cachesDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Caches")
        self.caches = caches

        self.tmp = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        self.bundle = appBundle.bundleURL
    }
}
