import Foundation
import JavaScriptCore

/// JSContext (compatibility engine) installer for the background-download host
/// functions.
///
/// Kept in its own file — separate from the JavaScriptCore-free
/// `BackgroundDownloadBridge` core — so the core type can compile into the
/// full-Bun engine build (which omits JavaScriptCore and never lists this file
/// in its podspec source set). On the compat path the closures funnel into the
/// same shared bridge used by the full-Bun `host_call` dispatch.
///
/// All three functions are synchronous native operations (kick off / read /
/// cancel a `URLSessionDownloadTask`) so they return their result value
/// directly to JS.
extension BackgroundDownloadBridge {
    public func install(into ctx: JSContext) {
        ctx.installBridgeFunction(name: "bg_download_start") { args in
            let payload = args.first?.toObject() as? [String: Any] ?? [:]
            let id = payload["id"] as? String ?? ""
            let url = payload["url"] as? String ?? ""
            let headers = (args.first?.forProperty("headers")).map { $0.toStringMap() } ?? [:]
            let destPath = payload["destPath"] as? String ?? ""
            let total = (payload["expectedTotalBytes"] as? NSNumber)?.int64Value ?? 0
            return self.start(
                id: id,
                urlString: url,
                headers: headers,
                destPath: destPath,
                expectedTotalBytes: total
            )
        }
        ctx.installBridgeFunction(name: "bg_download_status") { args in
            let payload = args.first?.toObject() as? [String: Any] ?? [:]
            let id = payload["id"] as? String ?? ""
            return self.status(id: id)
        }
        ctx.installBridgeFunction(name: "bg_download_cancel") { args in
            let payload = args.first?.toObject() as? [String: Any] ?? [:]
            let id = payload["id"] as? String ?? ""
            return self.cancel(id: id)
        }
    }
}
