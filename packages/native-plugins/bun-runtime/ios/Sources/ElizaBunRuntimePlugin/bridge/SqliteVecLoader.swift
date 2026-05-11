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
/// vendor-deps step), the loader is a no-op and `versionString` is nil.
/// Vector queries against tables that need the extension will fail with
/// SQLite's standard "no such module: vec0" error.
///
/// We detect availability at runtime via `dlsym(RTLD_DEFAULT, ...)` so the
/// loader compiles cleanly even when the .a is absent. This avoids forcing
/// every consumer of the bun-runtime pod to ship sqlite-vec.
public final class SqliteVecLoader {
    public static let shared = SqliteVecLoader()

    /// Reported by `bridge.sqlite_version()`. `nil` when the extension is
    /// not statically linked.
    public private(set) var versionString: String?

    private typealias VecInitFn = @convention(c) (
        OpaquePointer?,                                  // db
        UnsafeMutablePointer<UnsafeMutablePointer<Int8>?>?, // pzErrMsg
        UnsafePointer<sqlite3_api_routines>?            // pApi
    ) -> Int32

    private typealias VecVersionFn = @convention(c) () -> UnsafePointer<Int8>?

    private let initFn: VecInitFn?
    private let versionFn: VecVersionFn?

    private init() {
        let handle: UnsafeMutableRawPointer? = nil  // RTLD_DEFAULT
        if let sym = dlsym(handle, "sqlite3_vec_init") {
            self.initFn = unsafeBitCast(sym, to: VecInitFn.self)
        } else {
            self.initFn = nil
        }
        if let sym = dlsym(handle, "sqlite3_vec_version") {
            let fn = unsafeBitCast(sym, to: VecVersionFn.self)
            self.versionFn = fn
            if let cstr = fn() {
                self.versionString = String(cString: cstr)
            }
        } else {
            self.versionFn = nil
        }
    }

    /// Returns true iff the static lib is linked. Useful for logging and
    /// for the `sqlite_version` host function.
    public var isAvailable: Bool { initFn != nil }

    /// Calls `sqlite3_vec_init` on the given DB handle. No-op when the
    /// extension isn't linked. Errors during init are surfaced through
    /// stderr-only logging because we don't have a way to fail the open
    /// — the rest of the DB still works without vec0.
    public func register(on db: OpaquePointer) {
        guard let initFn = self.initFn else { return }
        var errPtr: UnsafeMutablePointer<Int8>? = nil
        let rc = initFn(db, &errPtr, nil)
        if rc != SQLITE_OK {
            let msg = errPtr != nil ? String(cString: errPtr!) : "sqlite3_vec_init rc=\(rc)"
            if let p = errPtr { sqlite3_free(p) }
            // We deliberately don't propagate — the bridge consumer
            // already logged the open, and vec queries that depend on
            // the extension will fail loudly at their own call sites.
            NSLog("[milady-sqlite-vec] init failed: %@", msg)
        }
    }
}
