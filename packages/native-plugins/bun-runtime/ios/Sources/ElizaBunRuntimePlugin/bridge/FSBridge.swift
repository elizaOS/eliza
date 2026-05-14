import Foundation
import JavaScriptCore

/// Implements the `fs_*` host functions from `BRIDGE_CONTRACT.md`.
///
/// All sync calls return `null` / `false` on failure and stash the error
/// string in a thread-local field readable via `fs_last_error()`.
public final class FSBridge {
    private weak var context: JSContext?
    private var lastError: String?

    public init() {}

    public func install(into ctx: JSContext) {
        self.context = ctx
        let fm = FileManager.default

        ctx.installBridgeFunction(name: "fs_read_text") { args in
            self.clearError()
            guard let path = args.first?.toString() else {
                self.setError("fs_read_text: missing path")
                return NSNull()
            }
            do {
                let s = try String(contentsOfFile: path, encoding: .utf8)
                return s
            } catch {
                self.setError("fs_read_text: \(error.localizedDescription)")
                return NSNull()
            }
        }

        ctx.installBridgeFunction(name: "fs_read_bytes") { args in
            self.clearError()
            guard let path = args.first?.toString() else {
                self.setError("fs_read_bytes: missing path")
                return NSNull()
            }
            do {
                let data = try Data(contentsOf: URL(fileURLWithPath: path))
                return ctx.newUint8Array(data)
            } catch {
                self.setError("fs_read_bytes: \(error.localizedDescription)")
                return NSNull()
            }
        }

        ctx.installBridgeFunction(name: "fs_write_text") { args in
            self.clearError()
            guard args.count >= 2,
                  let path = args[0].toString(),
                  let data = args[1].toString() else {
                self.setError("fs_write_text: missing args")
                return false
            }
            do {
                try data.write(toFile: path, atomically: true, encoding: .utf8)
                return true
            } catch {
                self.setError("fs_write_text: \(error.localizedDescription)")
                return false
            }
        }

        ctx.installBridgeFunction(name: "fs_write_bytes") { args in
            self.clearError()
            guard args.count >= 2,
                  let path = args[0].toString(),
                  let bytes = args[1].toData() else {
                self.setError("fs_write_bytes: missing args")
                return false
            }
            do {
                try bytes.write(to: URL(fileURLWithPath: path), options: .atomic)
                return true
            } catch {
                self.setError("fs_write_bytes: \(error.localizedDescription)")
                return false
            }
        }

        ctx.installBridgeFunction(name: "fs_append_text") { args in
            self.clearError()
            guard args.count >= 2,
                  let path = args[0].toString(),
                  let data = args[1].toString() else {
                self.setError("fs_append_text: missing args")
                return false
            }
            return self.appendText(path: path, text: data)
        }

        ctx.installBridgeFunction(name: "fs_exists") { args in
            self.clearError()
            guard let path = args.first?.toString() else { return false }
            return fm.fileExists(atPath: path)
        }

        ctx.installBridgeFunction(name: "fs_mkdir") { args in
            self.clearError()
            guard args.count >= 2,
                  let path = args[0].toString() else {
                self.setError("fs_mkdir: missing args")
                return false
            }
            let recursive = args[1].toBool()
            do {
                try fm.createDirectory(
                    atPath: path,
                    withIntermediateDirectories: recursive,
                    attributes: nil
                )
                return true
            } catch {
                self.setError("fs_mkdir: \(error.localizedDescription)")
                return false
            }
        }

        ctx.installBridgeFunction(name: "fs_readdir") { args in
            self.clearError()
            guard let path = args.first?.toString() else {
                self.setError("fs_readdir: missing path")
                return NSNull()
            }
            do {
                let entries = try fm.contentsOfDirectory(atPath: path)
                return entries
            } catch {
                self.setError("fs_readdir: \(error.localizedDescription)")
                return NSNull()
            }
        }

        ctx.installBridgeFunction(name: "fs_stat") { args in
            self.clearError()
            guard let path = args.first?.toString() else {
                self.setError("fs_stat: missing path")
                return NSNull()
            }
            do {
                let attrs = try fm.attributesOfItem(atPath: path)
                let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
                let mtimeDate = attrs[.modificationDate] as? Date
                let mtimeMs = (mtimeDate?.timeIntervalSince1970 ?? 0) * 1000.0
                let type = attrs[.type] as? FileAttributeType
                let isDir = (type == .typeDirectory)
                let isFile = (type == .typeRegular)
                return [
                    "size": size,
                    "mtime_ms": mtimeMs,
                    "is_directory": isDir,
                    "is_file": isFile,
                ] as [String: Any]
            } catch {
                self.setError("fs_stat: \(error.localizedDescription)")
                return NSNull()
            }
        }

        ctx.installBridgeFunction(name: "fs_remove") { args in
            self.clearError()
            guard let path = args.first?.toString() else {
                self.setError("fs_remove: missing path")
                return false
            }
            // `recursive` is an opt-in flag in the contract. FileManager
            // removeItem already recurses for directories, but if the caller
            // explicitly passes `false` for a directory we refuse so the
            // semantics match POSIX rm-vs-rm-rf.
            let recursive: Bool = args.count >= 2 ? args[1].toBool() : true
            var isDir: ObjCBool = false
            let exists = fm.fileExists(atPath: path, isDirectory: &isDir)
            if !exists {
                return true
            }
            if isDir.boolValue && !recursive {
                self.setError("fs_remove: path is a directory and recursive=false")
                return false
            }
            do {
                try fm.removeItem(atPath: path)
                return true
            } catch {
                self.setError("fs_remove: \(error.localizedDescription)")
                return false
            }
        }

        ctx.installBridgeFunction(name: "fs_rename") { args in
            self.clearError()
            guard args.count >= 2,
                  let from = args[0].toString(),
                  let to = args[1].toString() else {
                self.setError("fs_rename: missing args")
                return false
            }
            do {
                try fm.moveItem(atPath: from, toPath: to)
                return true
            } catch {
                self.setError("fs_rename: \(error.localizedDescription)")
                return false
            }
        }

        ctx.installBridgeFunction(name: "fs_copy") { args in
            self.clearError()
            guard args.count >= 2,
                  let from = args[0].toString(),
                  let to = args[1].toString() else {
                self.setError("fs_copy: missing args")
                return false
            }
            do {
                if fm.fileExists(atPath: to) {
                    try fm.removeItem(atPath: to)
                }
                try fm.copyItem(atPath: from, toPath: to)
                return true
            } catch {
                self.setError("fs_copy: \(error.localizedDescription)")
                return false
            }
        }

        ctx.installBridgeFunction(name: "fs_last_error") { _ in
            return self.lastError ?? NSNull()
        }
    }

    // MARK: - Internals

    private func setError(_ message: String) {
        self.lastError = message
    }

    private func clearError() {
        self.lastError = nil
    }

    /// Appends UTF-8 text to a file, creating it if missing. Returns false
    /// on failure and stashes a message in `lastError`.
    private func appendText(path: String, text: String) -> Bool {
        let fm = FileManager.default
        if !fm.fileExists(atPath: path) {
            do {
                try text.write(toFile: path, atomically: true, encoding: .utf8)
                return true
            } catch {
                setError("fs_append_text: \(error.localizedDescription)")
                return false
            }
        }
        guard let handle = FileHandle(forWritingAtPath: path),
              let bytes = text.data(using: .utf8) else {
            setError("fs_append_text: could not open file for writing")
            return false
        }
        defer { try? handle.close() }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: bytes)
            return true
        } catch {
            setError("fs_append_text: \(error.localizedDescription)")
            return false
        }
    }
}
