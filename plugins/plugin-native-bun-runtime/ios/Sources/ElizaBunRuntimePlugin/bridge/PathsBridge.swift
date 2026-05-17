import Foundation
import JavaScriptCore

/// Implements the `paths_*` host functions from `BRIDGE_CONTRACT.md`.
public final class PathsBridge {
    private let paths: SandboxPaths
    private weak var context: JSContext?

    public init(paths: SandboxPaths) {
        self.paths = paths
    }

    public func install(into ctx: JSContext) {
        self.context = ctx

        ctx.installBridgeFunction(name: "paths_app_support") { _ in
            return self.paths.appSupport.path
        }
        ctx.installBridgeFunction(name: "paths_documents") { _ in
            return self.paths.documents.path
        }
        ctx.installBridgeFunction(name: "paths_caches") { _ in
            return self.paths.caches.path
        }
        ctx.installBridgeFunction(name: "paths_tmp") { _ in
            return self.paths.tmp.path
        }
        ctx.installBridgeFunction(name: "paths_bundle") { _ in
            return self.paths.bundle.path
        }
        ctx.installBridgeFunction(name: "paths_bundle_resource") { args in
            guard args.count >= 2,
                  let name = args[0].toString(),
                  let ext = args[1].toString() else {
                return NSNull()
            }
            let url = Bundle.main.url(forResource: name, withExtension: ext.isEmpty ? nil : ext)
            return url?.path ?? NSNull()
        }
    }
}
