import AppKit
import Foundation

enum MacAutomationError: Error, LocalizedError {
    case appleScript(String)

    var errorDescription: String? {
        switch self {
        case .appleScript(let message):
            message
        }
    }
}

struct MacAutomationService {
    func revealInFinder(path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    func openTerminal(at path: String) throws {
        let source = """
        tell application "Terminal"
            activate
            do script "cd " & quoted form of \(appleScriptString(path))
        end tell
        """
        try runAppleScript(source)
    }

    func activateFinder() throws {
        try runAppleScript("""
        tell application "Finder"
            activate
        end tell
        """)
    }

    func openSystemSettings(_ url: URL) {
        NSWorkspace.shared.open(url)
    }

    private func runAppleScript(_ source: String) throws {
        guard let script = NSAppleScript(source: source) else {
            throw MacAutomationError.appleScript("AppleScript could not be compiled.")
        }

        var errorInfo: NSDictionary?
        script.executeAndReturnError(&errorInfo)

        if let errorInfo {
            throw MacAutomationError.appleScript(errorInfo.description)
        }
    }

    private func appleScriptString(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }
}
