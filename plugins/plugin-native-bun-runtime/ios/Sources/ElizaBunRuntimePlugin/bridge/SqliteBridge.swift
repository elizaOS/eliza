import Foundation
import JavaScriptCore
import SQLite3

// SQLite's transient/static destructor sentinels for `sqlite3_bind_*`.
// SQLITE_TRANSIENT forces sqlite3 to copy the bound bytes; SQLITE_STATIC
// promises the buffer outlives the statement. We always use TRANSIENT for
// safety since the Swift bridge passes Data slices that may be released.
private let SQLITE_TRANSIENT_BRIDGE = unsafeBitCast(
    OpaquePointer(bitPattern: -1),
    to: sqlite3_destructor_type.self
)

/// Implements the `sqlite_*` host functions from `BRIDGE_CONTRACT.md`.
///
/// PGlite cannot run inside JSContext on iOS 16.4+ (WebAssembly is disabled),
/// so the agent's plugin-sql is rebased onto SQLite via the polyfill's
/// `pglite-shim.ts`. This bridge exposes the raw libsqlite3 surface that
/// shim consumes.
///
/// Threading: every host-function body runs on the JSContext queue
/// (`ai.eliza.bun.runtime`). libsqlite3 is opened with `SQLITE_OPEN_FULLMUTEX`
/// so the same handle can be safely re-entered from that queue without extra
/// locking. Cross-queue use is forbidden by the contract.
///
/// Resource ownership:
///   - Open handles live in `databases[Int]` keyed by monotonic IDs.
///   - Prepared statements live in `statements[Int]` keyed by monotonic IDs.
///   - All allocations are freed when the JS side calls `sqlite_close` or
///     `sqlite_finalize`; the bridge also closes everything on `shutdown()`.
public final class SqliteBridge {
    private weak var context: JSContext?
    private var nextDbId: Int = 1
    private var nextStmtId: Int = 1
    private var databases: [Int: OpaquePointer] = [:]
    private var statements: [Int: StatementState] = [:]

    private struct StatementState {
        let stmt: OpaquePointer
        weak var dbValue: AnyObject?
        let dbId: Int
    }

    public init() {}

    public func install(into ctx: JSContext) {
        self.context = ctx

        ctx.installBridgeFunction(name: "sqlite_open") { args in
            return self.open(args: args, ctx: ctx)
        }

        ctx.installBridgeFunction(name: "sqlite_close") { args in
            guard let id = args.first?.toNumber()?.intValue else { return false }
            return self.closeDb(id: id)
        }

        ctx.installBridgeFunction(name: "sqlite_exec") { args in
            return self.exec(args: args)
        }

        ctx.installBridgeFunction(name: "sqlite_query") { args in
            return self.query(args: args, ctx: ctx)
        }

        ctx.installBridgeFunction(name: "sqlite_prepare") { args in
            return self.prepare(args: args)
        }

        ctx.installBridgeFunction(name: "sqlite_step") { args in
            return self.step(args: args, ctx: ctx)
        }

        ctx.installBridgeFunction(name: "sqlite_finalize") { args in
            guard let id = args.first?.toNumber()?.intValue else { return false }
            return self.finalizeStmt(id: id)
        }

        ctx.installBridgeFunction(name: "sqlite_version") { _ in
            return self.version()
        }
    }

    /// Closes every open DB and statement. Call when the runtime shuts down.
    public func shutdown() {
        for (id, _) in statements {
            _ = finalizeStmt(id: id)
        }
        for (id, _) in databases {
            _ = closeDb(id: id)
        }
    }

    // MARK: - Open / close

    private func open(args: [JSValue], ctx: JSContext) -> Any? {
        guard let opts = args.first, opts.isObject else {
            return ["error": "sqlite_open: missing options"]
        }
        guard let path = opts.forProperty("path")?.toString() else {
            return ["error": "sqlite_open: missing path"]
        }
        let readonly = opts.forProperty("readonly")?.toBool() ?? false
        let timeoutMs = opts.forProperty("timeout_ms")?.toNumber()?.intValue ?? 0

        // SqliteVecLoader will call sqlite3_vec_init on the resulting handle
        // when the static lib is linked. The flag set ensures multi-threaded
        // safety, which we need for re-entrant access from the same queue.
        var handle: OpaquePointer?
        let flags: Int32 = readonly
            ? (SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX)
            : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX)

        let rc = sqlite3_open_v2(path, &handle, flags, nil)
        if rc != SQLITE_OK {
            let message = handle != nil ? String(cString: sqlite3_errmsg(handle)) : "open failed (rc=\(rc))"
            if let h = handle { sqlite3_close_v2(h) }
            return ["error": "sqlite_open: \(message)"]
        }
        guard let db = handle else {
            return ["error": "sqlite_open: sqlite3_open_v2 returned nil handle"]
        }

        if timeoutMs > 0 {
            sqlite3_busy_timeout(db, Int32(timeoutMs))
        }

        // Activate sqlite-vec on this handle. The loader is a no-op when the
        // extension isn't statically linked.
        SqliteVecLoader.shared.register(on: db)

        let id = nextDbId
        nextDbId += 1
        databases[id] = db
        return ["db_id": id]
    }

    private func closeDb(id: Int) -> Bool {
        guard let db = databases.removeValue(forKey: id) else { return false }
        // Finalize any statements that still reference this DB before closing,
        // otherwise sqlite3_close_v2 leaks the prepared-statement memory until
        // the orphans GC themselves.
        let owned = statements.compactMap { (stmtId, state) -> Int? in
            state.dbId == id ? stmtId : nil
        }
        for sid in owned {
            _ = finalizeStmt(id: sid)
        }
        sqlite3_close_v2(db)
        return true
    }

    // MARK: - Exec

    private func exec(args: [JSValue]) -> Any? {
        guard args.count >= 2,
              let id = args[0].toNumber()?.intValue,
              let sql = args[1].toString() else {
            return ["error": "sqlite_exec: missing args"]
        }
        guard let db = databases[id] else {
            return ["error": "sqlite_exec: invalid db_id \(id)"]
        }
        var errPtr: UnsafeMutablePointer<Int8>?
        let rc = sqlite3_exec(db, sql, nil, nil, &errPtr)
        if rc != SQLITE_OK {
            let msg = errPtr != nil ? String(cString: errPtr!) : String(cString: sqlite3_errmsg(db))
            if let p = errPtr { sqlite3_free(p) }
            return ["error": "sqlite_exec: \(msg)"]
        }
        if let p = errPtr { sqlite3_free(p) }
        return ["rows_affected": Int(sqlite3_changes(db))]
    }

    // MARK: - Query (one-shot)

    private func query(args: [JSValue], ctx: JSContext) -> Any? {
        guard args.count >= 2,
              let id = args[0].toNumber()?.intValue,
              let sql = args[1].toString() else {
            return ["error": "sqlite_query: missing args"]
        }
        guard let db = databases[id] else {
            return ["error": "sqlite_query: invalid db_id \(id)"]
        }
        let params: [JSValue] = (args.count >= 3 && args[2].isArray)
            ? (args[2].toArray()?.compactMap { item -> JSValue? in
                if let v = item as? JSValue { return v }
                return JSValue(object: item, in: ctx)
            } ?? [])
            : []

        var stmt: OpaquePointer?
        var rc = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        if rc != SQLITE_OK {
            let msg = String(cString: sqlite3_errmsg(db))
            return ["error": "sqlite_query.prepare: \(msg)"]
        }
        defer { if let s = stmt { sqlite3_finalize(s) } }
        guard let s = stmt else {
            return ["error": "sqlite_query.prepare: returned nil statement"]
        }

        if let bindErr = bindParams(stmt: s, params: params, ctx: ctx) {
            return ["error": "sqlite_query.bind: \(bindErr)"]
        }

        let columnCount = Int(sqlite3_column_count(s))
        var columns: [String] = []
        columns.reserveCapacity(columnCount)
        for i in 0..<columnCount {
            if let cName = sqlite3_column_name(s, Int32(i)) {
                columns.append(String(cString: cName))
            } else {
                columns.append("column\(i)")
            }
        }

        var rows: [[Any?]] = []
        while true {
            rc = sqlite3_step(s)
            if rc == SQLITE_DONE { break }
            if rc != SQLITE_ROW {
                let msg = String(cString: sqlite3_errmsg(db))
                return ["error": "sqlite_query.step: \(msg)"]
            }
            rows.append(readRow(stmt: s, columnCount: columnCount, ctx: ctx))
        }

        return ["columns": columns, "rows": rows]
    }

    // MARK: - Prepare / step / finalize

    private func prepare(args: [JSValue]) -> Any? {
        guard args.count >= 2,
              let id = args[0].toNumber()?.intValue,
              let sql = args[1].toString() else {
            return ["error": "sqlite_prepare: missing args"]
        }
        guard let db = databases[id] else {
            return ["error": "sqlite_prepare: invalid db_id \(id)"]
        }
        var stmt: OpaquePointer?
        let rc = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        if rc != SQLITE_OK {
            let msg = String(cString: sqlite3_errmsg(db))
            return ["error": "sqlite_prepare: \(msg)"]
        }
        guard let s = stmt else {
            return ["error": "sqlite_prepare: returned nil statement"]
        }
        let sid = nextStmtId
        nextStmtId += 1
        statements[sid] = StatementState(stmt: s, dbValue: nil, dbId: id)
        return ["stmt_id": sid]
    }

    private func step(args: [JSValue], ctx: JSContext) -> Any? {
        guard let stmtId = args.first?.toNumber()?.intValue else {
            return ["error": "sqlite_step: missing stmt_id"]
        }
        guard let state = statements[stmtId] else {
            return ["error": "sqlite_step: invalid stmt_id \(stmtId)"]
        }
        let stmt = state.stmt

        // Re-bind on every call where params are provided. SQLite's
        // sqlite3_reset clears the row cursor but preserves bindings; we
        // explicitly clear+rebind to give callers a fresh-call illusion.
        if args.count >= 2 && args[1].isArray {
            sqlite3_reset(stmt)
            sqlite3_clear_bindings(stmt)
            let params: [JSValue] = args[1].toArray()?.compactMap { item -> JSValue? in
                if let v = item as? JSValue { return v }
                return JSValue(object: item, in: ctx)
            } ?? []
            if let bindErr = bindParams(stmt: stmt, params: params, ctx: ctx) {
                return ["error": "sqlite_step.bind: \(bindErr)"]
            }
        }

        let rc = sqlite3_step(stmt)
        if rc == SQLITE_DONE {
            return ["done": true]
        }
        if rc == SQLITE_ROW {
            let columnCount = Int(sqlite3_column_count(stmt))
            let row = readRow(stmt: stmt, columnCount: columnCount, ctx: ctx)
            return ["done": false, "row": row]
        }
        guard let db = databases[state.dbId] else {
            return ["error": "sqlite_step: db handle gone"]
        }
        let msg = String(cString: sqlite3_errmsg(db))
        return ["error": "sqlite_step: \(msg)"]
    }

    private func finalizeStmt(id: Int) -> Bool {
        guard let state = statements.removeValue(forKey: id) else { return false }
        sqlite3_finalize(state.stmt)
        return true
    }

    // MARK: - Version

    private func version() -> [String: Any] {
        var out: [String: Any] = [
            "sqlite": String(cString: sqlite3_libversion()),
        ]
        if let v = SqliteVecLoader.shared.versionString {
            out["sqlite_vec"] = v
        }
        return out
    }

    // MARK: - Binding + reading

    /// Binds positional parameters (1-indexed in SQLite) to `stmt`.
    /// Returns an error message on failure or `nil` on success.
    private func bindParams(stmt: OpaquePointer, params: [JSValue], ctx: JSContext) -> String? {
        for (i, value) in params.enumerated() {
            let idx = Int32(i + 1)
            let rc: Int32
            if value.isNullish {
                rc = sqlite3_bind_null(stmt, idx)
            } else if value.isBoolean {
                rc = sqlite3_bind_int64(stmt, idx, value.toBool() ? 1 : 0)
            } else if value.isNumber {
                // JS numbers are doubles. Detect integers and bind as INT64
                // to preserve exact representation for IDs and timestamps.
                let dbl = value.toDouble()
                if dbl.truncatingRemainder(dividingBy: 1) == 0
                    && dbl >= -9.2233720368547758e18
                    && dbl <= 9.2233720368547758e18 {
                    rc = sqlite3_bind_int64(stmt, idx, Int64(dbl))
                } else {
                    rc = sqlite3_bind_double(stmt, idx, dbl)
                }
            } else if value.isString {
                let s = value.toString() ?? ""
                rc = sqlite3_bind_text(stmt, idx, s, -1, SQLITE_TRANSIENT_BRIDGE)
            } else if let data = value.toData() {
                // Treat any TypedArray / ArrayBuffer-backed value as a BLOB.
                if data.isEmpty {
                    rc = sqlite3_bind_zeroblob(stmt, idx, 0)
                } else {
                    rc = data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Int32 in
                        guard let base = raw.baseAddress else {
                            return SQLITE_INTERNAL
                        }
                        return sqlite3_bind_blob(stmt, idx, base, Int32(data.count), SQLITE_TRANSIENT_BRIDGE)
                    }
                }
            } else {
                // Fall back to string coercion for unexpected JS types
                // (Date, Object, etc.). The shim layer typically pre-converts
                // these into ISO-8601 strings or JSON.
                let s = value.toString() ?? "null"
                rc = sqlite3_bind_text(stmt, idx, s, -1, SQLITE_TRANSIENT_BRIDGE)
            }
            if rc != SQLITE_OK {
                return "bind index \(idx): rc=\(rc)"
            }
        }
        return nil
    }

    /// Reads one row of a stepped statement into a Swift array. NULL → NSNull,
    /// INTEGER → Int, FLOAT → Double, TEXT → String, BLOB → Uint8Array JSValue.
    private func readRow(stmt: OpaquePointer, columnCount: Int, ctx: JSContext) -> [Any?] {
        var row: [Any?] = []
        row.reserveCapacity(columnCount)
        for i in 0..<columnCount {
            let col = Int32(i)
            let type = sqlite3_column_type(stmt, col)
            switch type {
            case SQLITE_INTEGER:
                row.append(NSNumber(value: sqlite3_column_int64(stmt, col)))
            case SQLITE_FLOAT:
                row.append(NSNumber(value: sqlite3_column_double(stmt, col)))
            case SQLITE_TEXT:
                if let cs = sqlite3_column_text(stmt, col) {
                    row.append(String(cString: cs))
                } else {
                    row.append(NSNull())
                }
            case SQLITE_BLOB:
                let n = Int(sqlite3_column_bytes(stmt, col))
                if n == 0 {
                    row.append(ctx.newUint8Array(Data()))
                } else if let raw = sqlite3_column_blob(stmt, col) {
                    let data = Data(bytes: raw, count: n)
                    row.append(ctx.newUint8Array(data))
                } else {
                    row.append(ctx.newUint8Array(Data()))
                }
            case SQLITE_NULL:
                row.append(NSNull())
            default:
                row.append(NSNull())
            }
        }
        return row
    }
}
