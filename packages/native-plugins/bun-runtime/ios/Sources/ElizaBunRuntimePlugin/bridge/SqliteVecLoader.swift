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
/// App Store/full-engine builds must not import dynamic loader symbols, so
/// sqlite-vec is either linked at build time with `ELIZA_IOS_INCLUDE_SQLITE_VEC`
/// or disabled. Development compatibility builds may still probe with `dlsym`
/// so the same pod can run without the optional static archive.
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
#if ELIZA_IOS_INCLUDE_SQLITE_VEC
        let loadedInitFn: VecInitFn = { db, errMsg, api in
            sqlite3_vec_init(db, errMsg, api)
        }
        let loadedVersionFn: VecVersionFn = {
            sqlite3_vec_version()
        }
        self.initFn = loadedInitFn
        self.versionFn = loadedVersionFn
        if let cstr = loadedVersionFn() {
            self.versionString = String(cString: cstr)
        }
#elseif ELIZA_IOS_FULL_BUN_ENGINE
        self.initFn = nil
        self.versionFn = nil
#else
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
#endif
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
            NSLog("[eliza-sqlite-vec] init failed: %@", msg)
        }
    }
}

#if ELIZA_IOS_INCLUDE_SQLITE_VEC
@_silgen_name("sqlite3_vec_init")
private func sqlite3_vec_init(
    _ db: OpaquePointer?,
    _ pzErrMsg: UnsafeMutablePointer<UnsafeMutablePointer<Int8>?>?,
    _ pApi: UnsafePointer<sqlite3_api_routines>?
) -> Int32

@_silgen_name("sqlite3_vec_version")
private func sqlite3_vec_version() -> UnsafePointer<Int8>?
#endif
