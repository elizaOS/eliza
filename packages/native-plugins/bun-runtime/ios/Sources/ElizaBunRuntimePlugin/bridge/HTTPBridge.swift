import Foundation
import JavaScriptCore

/// Implements `http_fetch` from `BRIDGE_CONTRACT.md`.
///
/// Returns a JS Promise via the constructor pattern: the bridge captures the
/// resolve callback as a `ManagedCallback`, runs the URLSession request off
/// the JSContext queue, then re-enters the JSContext queue to fulfill the
/// promise.
public final class HTTPBridge {
    private weak var context: JSContext?
    private let urlSession: URLSession

    public init(session: URLSession = .shared) {
        self.urlSession = session
    }

    public func install(into ctx: JSContext) {
        self.context = ctx

        ctx.installBridgeFunction(name: "http_fetch") { args in
            guard let ctx = self.context else { return NSNull() }
            guard let opts = args.first, opts.isObject else {
                return Self.rejectedPromise(in: ctx, error: "http_fetch: missing options")
            }

            let url = opts.objectForKeyedSubscript("url")?.toString() ?? ""
            let method = (opts.objectForKeyedSubscript("method")?.toString() ?? "GET").uppercased()
            let headers = opts.objectForKeyedSubscript("headers")?.toStringMap() ?? [:]
            let bodyValue = opts.objectForKeyedSubscript("body")
            let body: Data? = (bodyValue?.isNullish == false) ? bodyValue?.toData() : nil
            let timeoutMs = opts.objectForKeyedSubscript("timeout_ms")?.toNumber()?.doubleValue

            guard let target = URL(string: url) else {
                return Self.rejectedPromise(in: ctx, error: "http_fetch: invalid url")
            }

            var request = URLRequest(url: target)
            request.httpMethod = method
            for (k, v) in headers {
                request.setValue(v, forHTTPHeaderField: k)
            }
            if let body = body, method != "GET", method != "HEAD" {
                request.httpBody = body
            }
            if let ms = timeoutMs, ms > 0 {
                request.timeoutInterval = ms / 1000.0
            }

            return self.runFetch(ctx: ctx, request: request)
        }
    }

    // MARK: - Internals

    private func runFetch(ctx: JSContext, request: URLRequest) -> Any? {
        // Build the promise factory once.
        let promiseScript = """
        (function(){
          let resolveFn;
          const p = new Promise(function(res){ resolveFn = res; });
          p.__eliza_resolve = resolveFn;
          return p;
        })
        """
        guard let promise = ctx.evaluateScript(promiseScript)?.call(withArguments: []) else {
            return Self.rejectedPromise(in: ctx, error: "http_fetch: failed to construct promise")
        }
        let resolveValue = promise.forProperty("__eliza_resolve")
        let managedResolve = resolveValue.flatMap { ManagedCallback(value: $0) }

        let task = urlSession.dataTask(with: request) { data, response, error in
            let result = Self.buildResultDict(data: data, response: response, error: error, ctx: ctx)
            // Hop back onto the JS queue.
            RuntimeQueue.dispatchOnJS {
                guard let resolve = managedResolve else { return }
                resolve.callSync(args: [result])
            }
        }
        task.resume()

        return promise
    }

    private static func buildResultDict(data: Data?, response: URLResponse?, error: Error?, ctx: JSContext) -> [String: Any] {
        if let error = error {
            return [
                "status": 0,
                "headers": [:] as [String: String],
                "body": ctx.newUint8Array(Data()),
                "error": error.localizedDescription,
            ]
        }
        guard let http = response as? HTTPURLResponse else {
            return [
                "status": 0,
                "headers": [:] as [String: String],
                "body": ctx.newUint8Array(Data()),
                "error": "Non-HTTP response",
            ]
        }
        var headerDict: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
            guard let key = k as? String else { continue }
            headerDict[key.lowercased()] = String(describing: v)
        }
        let payload = data ?? Data()
        return [
            "status": http.statusCode,
            "headers": headerDict,
            "body": ctx.newUint8Array(payload),
        ]
    }

    private static func rejectedPromise(in ctx: JSContext, error: String) -> Any? {
        // Promise.resolve({ error }) per contract — async errors are returned,
        // not thrown.
        let script = "(function(msg){return Promise.resolve({status:0,headers:{},body:new Uint8Array(),error:msg});})"
        return ctx.evaluateScript(script)?.call(withArguments: [error])
    }
}
