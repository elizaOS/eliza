import Foundation
import Capacitor
import Network

/**
 * Gateway Plugin for Capacitor
 *
 * Provides WebSocket connectivity to an Eliza Gateway server.
 * This implementation handles authentication, reconnection, and RPC-style
 * request/response as well as event streaming. Also supports gateway
 * discovery via Bonjour/mDNS.
 */
@objc(GatewayPlugin)
public class GatewayPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GatewayPlugin"
    public let jsName = "Gateway"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDiscoveredGateways", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isConnected", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getConnectionInfo", returnType: CAPPluginReturnPromise),
    ]

    // Discovery
    private var browser: NWBrowser?
    private var discoveredGateways: [String: JSObject] = [:]
    private let serviceType = "_eliza-gw._tcp"
    private var isDiscovering = false

    private var webSocket: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var pendingRequests: [String: (resolve: (JSObject) -> Void, reject: (Error) -> Void)] = [:]
    private var options: JSObject?
    private var sessionId: String?
    private var protocolVersion: Int?
    private var role: String?
    private var scopes: [String] = []
    private var methods: [String] = []
    private var events: [String] = []
    private var lastSeq: Int?
    private var isClosed = false
    private var backoffMs: TimeInterval = 0.8
    private var reconnectTimer: Timer?
    private var connectContinuation: CheckedContinuation<JSObject, Error>?

    // MARK: - Discovery Methods

    @objc func startDiscovery(_ call: CAPPluginCall) {
        if isDiscovering {
            call.resolve(buildDiscoveryResult())
            return
        }

        let parameters = NWBrowser.Descriptor.bonjour(type: serviceType, domain: "local.")
        browser = NWBrowser(for: parameters, using: .tcp)

        browser?.browseResultsChangedHandler = { [weak self] results, changes in
            guard let self = self else { return }

            for change in changes {
                switch change {
                case .added(let result):
                    self.handleServiceFound(result)
                case .removed(let result):
                    self.handleServiceLost(result)
                default:
                    break
                }
            }
        }

        browser?.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.isDiscovering = true
            case .failed(let error):
                print("[Gateway] Browser failed: \(error)")
                self?.isDiscovering = false
            case .cancelled:
                self?.isDiscovering = false
            default:
                break
            }
        }

        browser?.start(queue: .main)

        // Return initial result after brief delay
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            call.resolve(self?.buildDiscoveryResult() ?? [:])
        }
    }

    @objc func stopDiscovery(_ call: CAPPluginCall) {
        browser?.cancel()
        browser = nil
        isDiscovering = false
        call.resolve()
    }

    @objc func getDiscoveredGateways(_ call: CAPPluginCall) {
        call.resolve(buildDiscoveryResult())
    }

    private func handleServiceFound(_ result: NWBrowser.Result) {
        guard case .service(let name, let type, let domain, _) = result.endpoint else { return }

        let connection = NWConnection(to: result.endpoint, using: .tcp)
        connection.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }

            if case .ready = state {
                if let endpoint = connection.currentPath?.remoteEndpoint,
                   case .hostPort(let host, let port) = endpoint {

                    let hostString: String
                    switch host {
                    case .ipv4(let addr):
                        hostString = "\(addr)"
                    case .ipv6(let addr):
                        hostString = "\(addr)"
                    case .name(let hostname, _):
                        hostString = hostname
                    @unknown default:
                        hostString = "unknown"
                    }

                    let id = self.stableId(name: name, domain: domain)
                    let displayName = self.decodeServiceName(name)

                    let gateway: JSObject = [
                        "stableId": id,
                        "name": displayName,
                        "host": hostString,
                        "port": Int(port.rawValue),
                        "gatewayPort": Int(port.rawValue),
                        "tlsEnabled": false,
                        "isLocal": true
                    ]

                    let isNew = self.discoveredGateways[id] == nil
                    self.discoveredGateways[id] = gateway

                    self.notifyListeners("discovery", data: [
                        "type": isNew ? "found" : "updated",
                        "gateway": gateway
                    ])
                }
                connection.cancel()
            }
        }
        connection.start(queue: .main)

        // Timeout for resolution
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            if connection.state != .ready {
                connection.cancel()
            }
        }
    }

    private func handleServiceLost(_ result: NWBrowser.Result) {
        guard case .service(let name, _, let domain, _) = result.endpoint else { return }

        let id = stableId(name: name, domain: domain)
        if let removed = discoveredGateways.removeValue(forKey: id) {
            notifyListeners("discovery", data: [
                "type": "lost",
                "gateway": removed
            ])
        }
    }

    private func stableId(name: String, domain: String) -> String {
        return "\(serviceType)|.\(domain)|.\(name.lowercased().trimmingCharacters(in: .whitespaces))"
    }

    private func decodeServiceName(_ raw: String) -> String {
        // Basic Bonjour escape decoding
        var result = raw
        let pattern = #"\\(\d{3})"#
        if let regex = try? NSRegularExpression(pattern: pattern) {
            let range = NSRange(result.startIndex..., in: result)
            let matches = regex.matches(in: result, range: range).reversed()
            for match in matches {
                if let codeRange = Range(match.range(at: 1), in: result),
                   let code = Int(result[codeRange]),
                   let scalar = Unicode.Scalar(code) {
                    let replacement = String(Character(scalar))
                    if let fullRange = Range(match.range, in: result) {
                        result.replaceSubrange(fullRange, with: replacement)
                    }
                }
            }
        }
        return result
    }

    private func buildDiscoveryResult() -> JSObject {
        let sortedGateways = discoveredGateways.values.sorted {
            ($0["name"] as? String ?? "").lowercased() < ($1["name"] as? String ?? "").lowercased()
        }

        return [
            "gateways": sortedGateways,
            "status": isDiscovering ? "Discovering..." : "Discovery stopped"
        ]
    }

    // MARK: - Connection Methods

    @objc func connect(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url") else {
            call.reject("Missing URL parameter")
            return
        }

        guard let url = URL(string: urlString) else {
            call.reject("Invalid URL")
            return
        }

        // Store options for reconnection
        options = call.jsObjectRepresentation

        // Close existing connection
        closeConnection()
        isClosed = false
        backoffMs = 0.8

        Task {
            do {
                let result = try await establishConnection(url: url, options: call.jsObjectRepresentation)
                call.resolve(result)
            } catch {
                call.reject("Connection failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        isClosed = true
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        closeConnection()
        sessionId = nil
        protocolVersion = nil
        notifyStateChange(state: "disconnected", reason: "Client disconnect")
        call.resolve()
    }

    @objc func isConnected(_ call: CAPPluginCall) {
        let connected = webSocket != nil && webSocket?.state == .running
        call.resolve(["connected": connected])
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let method = call.getString("method") else {
            call.reject("Missing method parameter")
            return
        }

        guard let ws = webSocket, ws.state == .running else {
            call.resolve([
                "ok": false,
                "error": [
                    "code": "NOT_CONNECTED",
                    "message": "Not connected to gateway"
                ]
            ])
            return
        }

        let id = UUID().uuidString
        let params = call.getObject("params") ?? [:]

        let frame: [String: Any] = [
            "type": "req",
            "id": id,
            "method": method,
            "params": params
        ]

        Task {
            do {
                let result = try await sendRequest(id: id, frame: frame)
                call.resolve(result)
            } catch {
                call.resolve([
                    "ok": false,
                    "error": [
                        "code": "REQUEST_FAILED",
                        "message": error.localizedDescription
                    ]
                ])
            }
        }
    }

    @objc func getConnectionInfo(_ call: CAPPluginCall) {
        call.resolve([
            "url": options?["url"] as? String ?? NSNull(),
            "sessionId": sessionId ?? NSNull(),
            "protocol": protocolVersion ?? NSNull(),
            "role": role ?? NSNull()
        ])
    }

    // MARK: - Private Methods

    private func establishConnection(url: URL, options: JSObject) async throws -> JSObject {
        // Create URL session with delegate
        let config = URLSessionConfiguration.default
        urlSession = URLSession(configuration: config, delegate: nil, delegateQueue: nil)

        var request = URLRequest(url: url)
        request.timeoutInterval = 30

        webSocket = urlSession?.webSocketTask(with: request)
        webSocket?.resume()

        // Start receiving messages
        startReceiving()

        // Send connect frame
        return try await sendConnectFrame(options: options)
    }

    private func sendConnectFrame(options: JSObject) async throws -> JSObject {
        return try await withCheckedThrowingContinuation { continuation in
            let clientName = options["clientName"] as? String ?? "eliza-capacitor-ios"
            let clientVersion = options["clientVersion"] as? String ?? "1.0.0"
            let roleParam = options["role"] as? String ?? "operator"
            let scopesParam = options["scopes"] as? [String] ?? ["operator.admin"]

            var auth: [String: Any] = [:]
            if let token = options["token"] as? String {
                auth["token"] = token
            }
            if let password = options["password"] as? String {
                auth["password"] = password
            }

            let params: [String: Any] = [
                "minProtocol": 3,
                "maxProtocol": 3,
                "client": [
                    "id": clientName,
                    "version": clientVersion,
                    "platform": "ios",
                    "mode": "ui"
                ],
                "role": roleParam,
                "scopes": scopesParam,
                "caps": [],
                "auth": auth
            ]

            let id = UUID().uuidString
            let frame: [String: Any] = [
                "type": "req",
                "id": id,
                "method": "connect",
                "params": params
            ]

            // Store continuation for response
            self.connectContinuation = continuation

            do {
                let jsonData = try JSONSerialization.data(withJSONObject: frame)
                guard let jsonString = String(data: jsonData, encoding: .utf8) else {
                    continuation.resume(throwing: NSError(domain: "GatewayPlugin", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to serialize connect frame"]))
                    self.connectContinuation = nil
                    return
                }

                webSocket?.send(.string(jsonString)) { [weak self] error in
                    if let error = error {
                        self?.connectContinuation?.resume(throwing: error)
                        self?.connectContinuation = nil
                    }
                    // Response will come via receiveMessage
                }

                // Set timeout
                DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
                    if self?.connectContinuation != nil {
                        self?.connectContinuation?.resume(throwing: NSError(domain: "GatewayPlugin", code: -1, userInfo: [NSLocalizedDescriptionKey: "Connection timeout"]))
                        self?.connectContinuation = nil
                    }
                }
            } catch {
                continuation.resume(throwing: error)
                self.connectContinuation = nil
            }
        }
    }

    private func sendRequest(id: String, frame: [String: Any]) async throws -> JSObject {
        return try await withCheckedThrowingContinuation { continuation in
            pendingRequests[id] = (
                resolve: { result in continuation.resume(returning: result) },
                reject: { error in continuation.resume(throwing: error) }
            )

            do {
                let jsonData = try JSONSerialization.data(withJSONObject: frame)
                guard let jsonString = String(data: jsonData, encoding: .utf8) else {
                    pendingRequests.removeValue(forKey: id)
                    continuation.resume(throwing: NSError(domain: "GatewayPlugin", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to serialize request"]))
                    return
                }

                webSocket?.send(.string(jsonString)) { [weak self] error in
                    if let error = error {
                        self?.pendingRequests.removeValue(forKey: id)
                        continuation.resume(throwing: error)
                    }
                }

                // Set timeout
                DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
                    if self?.pendingRequests[id] != nil {
                        self?.pendingRequests.removeValue(forKey: id)
                        continuation.resume(returning: [
                            "ok": false,
                            "error": [
                                "code": "TIMEOUT",
                                "message": "Request timed out"
                            ]
                        ])
                    }
                }
            } catch {
                pendingRequests.removeValue(forKey: id)
                continuation.resume(throwing: error)
            }
        }
    }

    private func startReceiving() {
        webSocket?.receive { [weak self] result in
            guard let self = self else { return }

            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleMessage(text)
                    }
                @unknown default:
                    break
                }
                // Continue receiving
                if self.webSocket?.state == .running {
                    self.startReceiving()
                }

            case .failure(let error):
                self.handleClose(error: error)
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }

        let frameType = json["type"] as? String

        // Handle response frames
        if frameType == "res" {
            guard let id = json["id"] as? String else { return }

            // Check if this is the connect response
            if connectContinuation != nil {
                let ok = json["ok"] as? Bool ?? false
                if ok, let payload = json["payload"] as? [String: Any] {
                    handleHelloOk(payload)
                    let result: JSObject = [
                        "connected": true,
                        "sessionId": sessionId ?? "",
                        "protocol": protocolVersion ?? 3,
                        "methods": methods,
                        "events": events,
                        "role": role ?? "",
                        "scopes": scopes
                    ]
                    connectContinuation?.resume(returning: result)
                    connectContinuation = nil
                } else {
                    let errorMsg = (json["error"] as? [String: Any])?["message"] as? String ?? "Connection failed"
                    connectContinuation?.resume(throwing: NSError(domain: "GatewayPlugin", code: -1, userInfo: [NSLocalizedDescriptionKey: errorMsg]))
                    connectContinuation = nil
                }
                return
            }

            // Handle pending request
            if let pending = pendingRequests[id] {
                pendingRequests.removeValue(forKey: id)
                let ok = json["ok"] as? Bool ?? false
                var result: JSObject = ["ok": ok]
                if let payload = json["payload"] {
                    result["payload"] = payload as? JSValue
                }
                if let error = json["error"] as? JSObject {
                    result["error"] = error
                }
                pending.resolve(result)
            }
            return
        }

        // Handle event frames
        if frameType == "event" {
            guard let event = json["event"] as? String else { return }
            let payload = json["payload"]
            let seq = json["seq"] as? Int

            // Check for sequence gap
            if let seq = seq, let lastSeq = lastSeq, seq > lastSeq + 1 {
                print("[Gateway] Event sequence gap: expected \(lastSeq + 1), got \(seq)")
            }
            if let seq = seq {
                lastSeq = seq
            }

            // Emit event
            var eventData: JSObject = ["event": event]
            if let payload = payload {
                eventData["payload"] = payload as? JSValue
            }
            if let seq = seq {
                eventData["seq"] = seq
            }
            notifyListeners("gatewayEvent", data: eventData)
        }
    }

    private func handleHelloOk(_ payload: [String: Any]) {
        sessionId = UUID().uuidString
        protocolVersion = payload["protocol"] as? Int ?? 3

        if let auth = payload["auth"] as? [String: Any] {
            role = auth["role"] as? String
            scopes = auth["scopes"] as? [String] ?? []
        }

        if let features = payload["features"] as? [String: Any] {
            methods = features["methods"] as? [String] ?? []
            events = features["events"] as? [String] ?? []
        }

        backoffMs = 0.8
        notifyStateChange(state: "connected")
    }

    private func handleClose(error: Error?) {
        webSocket = nil

        // Reject all pending requests
        for (_, pending) in pendingRequests {
            pending.reject(NSError(domain: "GatewayPlugin", code: -1, userInfo: [NSLocalizedDescriptionKey: "Connection closed"]))
        }
        pendingRequests.removeAll()

        if isClosed {
            notifyStateChange(state: "disconnected", reason: error?.localizedDescription)
            return
        }

        // Attempt reconnection
        notifyStateChange(state: "reconnecting", reason: error?.localizedDescription)
        notifyListeners("error", data: [
            "message": "Connection lost: \(error?.localizedDescription ?? "unknown")",
            "willRetry": true
        ])

        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard !isClosed, reconnectTimer == nil else { return }

        let delay = backoffMs
        backoffMs = min(backoffMs * 1.7, 15.0)

        reconnectTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            self?.reconnectTimer = nil
            guard let self = self,
                  let urlString = self.options?["url"] as? String,
                  let url = URL(string: urlString) else {
                return
            }

            Task {
                do {
                    _ = try await self.establishConnection(url: url, options: self.options ?? [:])
                } catch {
                    self.handleClose(error: error)
                }
            }
        }
    }

    private func closeConnection() {
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
    }

    private func notifyStateChange(state: String, reason: String? = nil) {
        var data: JSObject = ["state": state]
        if let reason = reason {
            data["reason"] = reason
        }
        notifyListeners("stateChange", data: data)
    }
}
