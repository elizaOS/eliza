import Foundation
import JavaScriptCore
import Network

/// Implements `http_serve_*` from `BRIDGE_CONTRACT.md` via Network.framework.
///
/// The server binds to 127.0.0.1 only (loopback). It accepts HTTP/1.1 from
/// the WebView and dispatches each request to a JS handler registered under
/// a token. The handler returns a Promise<{ status, headers, body }>, which
/// the server awaits and writes back to the connection.
public final class HTTPServerBridge {
    private weak var context: JSContext?
    private var listeners: [String: NWListener] = [:]
    private var handlers: [String: ManagedCallback] = [:]
    private let serverQueue = DispatchQueue(label: "ai.eliza.bun.runtime.httpserver", qos: .userInitiated)

    public init() {}

    public func install(into ctx: JSContext) {
        self.context = ctx

        ctx.installBridgeFunction(name: "http_serve_start") { args in
            guard let ctx = self.context else { return ["ok": false, "port": 0, "error": "no ctx"] }
            guard let opts = args.first, opts.isObject else {
                return ["ok": false, "port": 0, "error": "http_serve_start: missing options"]
            }
            let port = opts.objectForKeyedSubscript("port")?.toNumber()?.intValue ?? 0
            let token = opts.objectForKeyedSubscript("handler_token")?.toString() ?? ""
            if token.isEmpty {
                return ["ok": false, "port": 0, "error": "http_serve_start: handler_token required"]
            }
            return self.startListener(token: token, requestedPort: port, ctx: ctx)
        }

        ctx.installBridgeFunction(name: "http_serve_register_handler") { args in
            guard args.count >= 2,
                  let token = args[0].toString() else {
                return NSNull()
            }
            let handlerValue = args[1]
            guard handlerValue.isObject, let mc = ManagedCallback(value: handlerValue) else {
                return NSNull()
            }
            self.handlers[token] = mc
            return NSNull()
        }

        ctx.installBridgeFunction(name: "http_serve_stop") { args in
            guard let token = args.first?.toString() else { return NSNull() }
            self.stopListener(token: token)
            return NSNull()
        }
    }

    // MARK: - Server lifecycle

    private func startListener(token: String, requestedPort: Int, ctx: JSContext) -> [String: Any] {
        let nwPort: NWEndpoint.Port = requestedPort == 0
            ? NWEndpoint.Port.any
            : (NWEndpoint.Port(rawValue: UInt16(requestedPort)) ?? NWEndpoint.Port.any)

        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: NWEndpoint.Host("127.0.0.1"),
            port: nwPort
        )
        params.allowLocalEndpointReuse = true

        let listener: NWListener
        do {
            listener = try NWListener(using: params, on: nwPort)
        } catch {
            return ["ok": false, "port": 0, "error": "NWListener init: \(error.localizedDescription)"]
        }

        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection: connection, token: token)
        }

        let ready = DispatchSemaphore(value: 0)
        var boundPort: Int = requestedPort
        var startError: String?
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                if let p = listener.port?.rawValue {
                    boundPort = Int(p)
                }
                ready.signal()
            case .failed(let err):
                startError = err.localizedDescription
                ready.signal()
            case .cancelled:
                break
            default:
                break
            }
        }
        listener.start(queue: serverQueue)

        // Wait briefly for the port-bind. Network.framework binds immediately
        // in practice; we cap at 2s to avoid hangs in pathological cases.
        _ = ready.wait(timeout: .now() + .seconds(2))

        if let err = startError {
            return ["ok": false, "port": 0, "error": err]
        }

        self.listeners[token] = listener
        return ["ok": true, "port": boundPort]
    }

    private func stopListener(token: String) {
        if let listener = listeners.removeValue(forKey: token) {
            listener.cancel()
        }
        handlers.removeValue(forKey: token)
    }

    // MARK: - Connection / request handling

    private func accept(connection: NWConnection, token: String) {
        connection.start(queue: serverQueue)
        receiveRequest(connection: connection, token: token, accumulator: Data())
    }

    /// Reads bytes from the connection until a full HTTP/1.1 request has
    /// been received (headers + body up to Content-Length). Then invokes
    /// the JS handler and writes back the response.
    private func receiveRequest(connection: NWConnection, token: String, accumulator: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] chunk, _, isComplete, error in
            guard let self = self else {
                connection.cancel()
                return
            }
            if let error = error {
                NSLog("[ElizaBunRuntime] http server recv error: \(error.localizedDescription)")
                connection.cancel()
                return
            }
            var buf = accumulator
            if let chunk = chunk {
                buf.append(chunk)
            }

            guard let parsed = self.tryParseRequest(buf) else {
                if isComplete {
                    connection.cancel()
                    return
                }
                self.receiveRequest(connection: connection, token: token, accumulator: buf)
                return
            }

            self.handle(request: parsed, token: token, connection: connection)
        }
    }

    private func handle(request: ParsedHTTPRequest, token: String, connection: NWConnection) {
        guard let handler = handlers[token] else {
            Self.writeResponse(connection: connection,
                               status: 503,
                               headers: ["content-type": "text/plain"],
                               body: Data("No handler registered".utf8))
            return
        }
        guard let ctx = context else {
            connection.cancel()
            return
        }
        let requestPayload: [String: Any] = [
            "method": request.method,
            "url": request.url,
            "headers": request.headers,
            "body": ctx.newUint8Array(request.body),
        ]

        RuntimeQueue.dispatchOnJS {
            // Call handler. If it returns a Promise, .then it. Otherwise treat
            // as a direct response.
            guard let value = handler.callSync(args: [requestPayload]) else {
                Self.writeResponse(connection: connection,
                                   status: 500,
                                   headers: ["content-type": "text/plain"],
                                   body: Data("Handler returned undefined".utf8))
                return
            }
            self.resolveResponse(value: value, connection: connection, ctx: ctx)
        }
    }

    /// Awaits a JS handler result (Promise or direct dict) and writes the
    /// HTTP response. Promise resolution is wired via two ManagedCallbacks
    /// for then/catch.
    private func resolveResponse(value: JSValue, connection: NWConnection, ctx: JSContext) {
        // Detect "thenable"
        let thenFn = value.objectForKeyedSubscript("then")
        if thenFn != nil && thenFn?.isObject == true {
            // Build success / failure callbacks.
            let onResolve: @convention(block) (JSValue) -> Void = { [weak self] resolved in
                self?.writeFromJSResponse(value: resolved, connection: connection, ctx: ctx)
            }
            let onReject: @convention(block) (JSValue) -> Void = { rejected in
                let msg = rejected.toString() ?? "handler rejected"
                Self.writeResponse(connection: connection,
                                   status: 500,
                                   headers: ["content-type": "text/plain"],
                                   body: Data(msg.utf8))
            }
            let resolveJS = JSValue(object: unsafeBitCast(onResolve, to: AnyObject.self), in: ctx)
            let rejectJS = JSValue(object: unsafeBitCast(onReject, to: AnyObject.self), in: ctx)
            _ = thenFn?.call(withArguments: [resolveJS as Any, rejectJS as Any])
            return
        }
        writeFromJSResponse(value: value, connection: connection, ctx: ctx)
    }

    private func writeFromJSResponse(value: JSValue, connection: NWConnection, ctx: JSContext) {
        if !value.isObject {
            Self.writeResponse(connection: connection,
                               status: 500,
                               headers: ["content-type": "text/plain"],
                               body: Data("handler returned non-object".utf8))
            return
        }
        let status = value.objectForKeyedSubscript("status")?.toNumber()?.intValue ?? 200
        let headers = value.objectForKeyedSubscript("headers")?.toStringMap() ?? [:]
        let bodyVal = value.objectForKeyedSubscript("body")
        var bodyData: Data = Data()
        if let bodyVal = bodyVal {
            if bodyVal.isString {
                bodyData = Data((bodyVal.toString() ?? "").utf8)
            } else if let d = bodyVal.toData() {
                bodyData = d
            }
        }
        Self.writeResponse(connection: connection,
                           status: status,
                           headers: headers,
                           body: bodyData)
    }

    // MARK: - HTTP parsing + serialization

    struct ParsedHTTPRequest {
        let method: String
        let url: String
        let headers: [String: String]
        let body: Data
    }

    /// Minimal HTTP/1.1 parser. Returns nil if we don't have a complete
    /// request yet. Doesn't handle chunked transfer; bun.serve handlers on
    /// iOS see only the WebView, which never chunks.
    private func tryParseRequest(_ data: Data) -> ParsedHTTPRequest? {
        // Find header/body split.
        let needle = Data("\r\n\r\n".utf8)
        guard let separator = data.range(of: needle) else { return nil }
        let headerData = data.subdata(in: 0..<separator.lowerBound)
        let bodyStart = separator.upperBound

        guard let headerString = String(data: headerData, encoding: .utf8) else { return nil }
        let lines = headerString.split(separator: "\r\n", omittingEmptySubsequences: false).map(String.init)
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 2 else { return nil }
        let method = parts[0]
        let url = parts[1]

        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            if line.isEmpty { continue }
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = String(line[line.startIndex..<colon]).trimmingCharacters(in: .whitespaces).lowercased()
            let value = String(line[line.index(after: colon)..<line.endIndex]).trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }

        let contentLength = headers["content-length"].flatMap { Int($0) } ?? 0
        let availableBody = data.count - bodyStart
        if availableBody < contentLength {
            return nil // need more bytes
        }

        let body = contentLength > 0
            ? data.subdata(in: bodyStart..<(bodyStart + contentLength))
            : Data()

        return ParsedHTTPRequest(method: method, url: url, headers: headers, body: body)
    }

    private static func writeResponse(connection: NWConnection, status: Int, headers: [String: String], body: Data) {
        let statusText = HTTPURLResponse.localizedString(forStatusCode: status)
        var out = "HTTP/1.1 \(status) \(statusText)\r\n"

        var mergedHeaders = headers
        if mergedHeaders["content-length"] == nil {
            mergedHeaders["content-length"] = String(body.count)
        }
        if mergedHeaders["connection"] == nil {
            mergedHeaders["connection"] = "close"
        }
        for (k, v) in mergedHeaders {
            out.append("\(k): \(v)\r\n")
        }
        out.append("\r\n")

        var payload = Data(out.utf8)
        payload.append(body)
        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    public func shutdown() {
        for (_, listener) in listeners {
            listener.cancel()
        }
        listeners.removeAll()
        handlers.removeAll()
    }
}
