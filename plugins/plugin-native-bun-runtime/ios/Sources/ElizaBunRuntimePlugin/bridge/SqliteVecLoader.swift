import Foundation
import SQLite3

/// Conditional loader for the `sqlite-vec` (https://github.com/asg017/sqlite-vec)
/// extension.
///
/// When the static library is linked into the binary, the symbol
/// `sqlite3_vec_init` is available and we invoke it on each opened DB so
/// the `vec0` virtual table module and the `vec_distance_*` SQL helpers
/// are registered.
///
/// When sqlite-vec is *not* linked (e.g. simulator builds without the
/// vendor-deps step), the weak C shim reports unavailable, the loader is a
/// no-op, and `versionString` is nil. Vector queries against tables that need
/// the extension will fail with SQLite's standard "no such module: vec0"
/// error.
public final class SqliteVecLoader {
    public static let shared = SqliteVecLoader()

    /// Reported by `bridge.sqlite_version()`. `nil` when the extension is
    /// not statically linked.
    public private(set) var versionString: String?

    private let available: Bool

    private init() {
        self.available = eliza_sqlite_vec_is_available() == 1
        if let cstr = eliza_sqlite_vec_version() {
            self.versionString = String(cString: cstr)
        }
    }

    /// Returns true iff the static lib is linked. Useful for logging and
    /// for the `sqlite_version` host function.
    public var isAvailable: Bool { available }

    /// Calls `sqlite3_vec_init` on the given DB handle. No-op when the
    /// extension isn't linked. Errors during init are surfaced through
    /// stderr-only logging because we don't have a way to fail the open
    /// — the rest of the DB still works without vec0.
    public func register(on db: OpaquePointer) {
        guard available else { return }
        var errPtr: UnsafeMutablePointer<Int8>? = nil
        let rc = eliza_sqlite_vec_register(db, &errPtr)
        if rc != SQLITE_OK {
            let msg = errPtr != nil ? String(cString: errPtr!) : "sqlite3_vec_init rc=\(rc)"
            if let p = errPtr { sqlite3_free(p) }
            // We deliberately don't propagate — the bridge consumer
            // already logged the open, and vec queries that depend on
            // the extension will fail loudly at their own call sites.
            NSLog("[eliza-sqlite-vec] init failed: %@", msg)
        }
    }
}

@_silgen_name("eliza_sqlite_vec_is_available")
private func eliza_sqlite_vec_is_available() -> Int32

@_silgen_name("eliza_sqlite_vec_version")
private func eliza_sqlite_vec_version() -> UnsafePointer<CChar>?

@_silgen_name("eliza_sqlite_vec_register")
private func eliza_sqlite_vec_register(
    _ db: OpaquePointer?,
    _ pzErrMsg: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32
