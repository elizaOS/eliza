import Foundation
import Capacitor

extension GatewayPlugin {
    func establishConnection(url: URL, options: JSObject) async throws -> JSObject {
        urlSession = URLSession(configuration: .default, delegate: nil, delegateQueue: nil)
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        webSocket = urlSession?.webSocketTask(with: request)
        webSocket?.resume()
        startReceiving()
        return try await sendConnectFrame(options: options)
    }

    func sendConnectFrame(options: JSObject) async throws -> JSObject {
        let frame = buildConnectFrame(options: options)
        return try await withCheckedThrowingContinuation { continuation in
            connectContinuation = continuation
            do {
                try sendSerializedFrame(frame) { [weak self] error in
                    guard let error else { return }
                    self?.connectContinuation?.resume(throwing: error)
                    self?.connectContinuation = nil
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
                    guard let self, self.connectContinuation != nil else { return }
                    self.connectContinuation?.resume(throwing: self.gatewayError("Connection timeout"))
                    self.connectContinuation = nil
                }
            } catch {
                continuation.resume(throwing: error)
                self.connectContinuation = nil
            }
        }
    }

    func buildConnectFrame(options: JSObject) -> [String: Any] {
        var auth: [String: Any] = [:]
        if let token = options["token"] as? String { auth["token"] = token }
        if let password = options["password"] as? String { auth["password"] = password }
        return [
            "type": "req",
            "id": UUID().uuidString,
            "method": "connect",
            "params": [
                "minProtocol": 3,
                "maxProtocol": 3,
                "client": [
                    "id": options["clientName"] as? String ?? "eliza-capacitor-ios",
                    "version": options["clientVersion"] as? String ?? "1.0.0",
                    "platform": "ios",
                    "mode": "ui"
                ],
                "role": options["role"] as? String ?? "operator",
                "scopes": options["scopes"] as? [String] ?? ["operator.admin"],
                "caps": [],
                "auth": auth
            ]
        ]
    }

    func sendRequest(id: String, frame: [String: Any]) async throws -> JSObject {
        try await withCheckedThrowingContinuation { continuation in
            pendingRequests[id] = (
                resolve: { continuation.resume(returning: $0) },
                reject: { continuation.resume(throwing: $0) }
            )
            do {
                try sendSerializedFrame(frame) { [weak self] error in
                    guard let error else { return }
                    self?.pendingRequests.removeValue(forKey: id)
                    continuation.resume(throwing: error)
                }
                scheduleRequestTimeout(id: id, continuation: continuation)
            } catch {
                pendingRequests.removeValue(forKey: id)
                continuation.resume(throwing: error)
            }
        }
    }

    func sendSerializedFrame(
        _ frame: [String: Any],
        completion: @escaping (Error?) -> Void
    ) throws {
        let jsonData = try JSONSerialization.data(withJSONObject: frame)
        guard let jsonString = String(data: jsonData, encoding: .utf8) else {
            throw gatewayError("Failed to serialize request")
        }
        webSocket?.send(.string(jsonString), completionHandler: completion)
    }

    func scheduleRequestTimeout(
        id: String,
        continuation: CheckedContinuation<JSObject, Error>
    ) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
            guard self?.pendingRequests.removeValue(forKey: id) != nil else { return }
            continuation.resume(returning: [
                "ok": false,
                "error": ["code": "TIMEOUT", "message": "Request timed out"]
            ])
        }
    }

    func startReceiving() {
        webSocket?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .string(let text): self.handleMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) { self.handleMessage(text) }
                @unknown default: break
                }
                if self.webSocket?.state == .running { self.startReceiving() }
            case .failure(let error): self.handleClose(error: error)
            }
        }
    }

    func handleMessage(_ text: String) {
        guard
            let data = text.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        switch json["type"] as? String {
        case "res": handleResponseFrame(json)
        case "event": handleEventFrame(json)
        default: break
        }
    }

    func handleResponseFrame(_ json: [String: Any]) {
        guard let requestId = json["id"] as? String else { return }
        if connectContinuation != nil {
            resolveConnectResponse(json)
            return
        }
        guard let pending = pendingRequests.removeValue(forKey: requestId) else { return }
        let succeeded = json["ok"] as? Bool ?? false
        var result: JSObject = ["ok": succeeded]
        if let payload = json["payload"] { result["payload"] = payload as? JSValue }
        if let error = json["error"] as? JSObject { result["error"] = error }
        pending.resolve(result)
    }

    func resolveConnectResponse(_ json: [String: Any]) {
        let succeeded = json["ok"] as? Bool ?? false
        if succeeded, let payload = json["payload"] as? [String: Any] {
            handleHelloOk(payload)
            connectContinuation?.resume(returning: [
                "connected": true,
                "sessionId": sessionId ?? "",
                "protocol": protocolVersion ?? 3,
                "methods": methods,
                "events": events,
                "role": role ?? "",
                "scopes": scopes
            ])
        } else {
            let message = (json["error"] as? [String: Any])?["message"] as? String
            connectContinuation?.resume(throwing: gatewayError(message ?? "Connection failed"))
        }
        connectContinuation = nil
    }

    func handleEventFrame(_ json: [String: Any]) {
        guard let event = json["event"] as? String else { return }
        let sequence = json["seq"] as? Int
        if let sequence, let lastSequence, sequence > lastSequence + 1 {
            print("[Gateway] Event sequence gap: expected \(lastSequence + 1), got \(sequence)")
        }
        if let sequence { lastSequence = sequence }
        var eventData: JSObject = ["event": event]
        if let payload = json["payload"] { eventData["payload"] = payload as? JSValue }
        if let sequence { eventData["seq"] = sequence }
        notifyListeners("gatewayEvent", data: eventData)
    }

    func handleHelloOk(_ payload: [String: Any]) {
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

    func handleClose(error: Error?) {
        webSocket = nil
        for (_, pending) in pendingRequests { pending.reject(gatewayError("Connection closed")) }
        pendingRequests.removeAll()
        if isClosed {
            notifyStateChange(state: "disconnected", reason: error?.localizedDescription)
            return
        }
        notifyStateChange(state: "reconnecting", reason: error?.localizedDescription)
        notifyListeners("error", data: [
            "message": "Connection lost: \(error?.localizedDescription ?? "unknown")",
            "willRetry": true
        ])
        scheduleReconnect()
    }

    func scheduleReconnect() {
        guard !isClosed, reconnectTimer == nil else { return }
        let delay = backoffMs
        backoffMs = min(backoffMs * 1.7, 15.0)
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            self?.reconnectTimer = nil
            guard
                let self,
                let urlString = self.options?["url"] as? String,
                let url = URL(string: urlString)
            else { return }
            Task {
                do {
                    _ = try await self.establishConnection(url: url, options: self.options ?? [:])
                } catch {
                    self.handleClose(error: error)
                }
            }
        }
    }

    func closeConnection() {
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
    }

    func notifyStateChange(state: String, reason: String? = nil) {
        var data: JSObject = ["state": state]
        if let reason { data["reason"] = reason }
        notifyListeners("stateChange", data: data)
    }

    func gatewayError(_ message: String) -> NSError {
        NSError(
            domain: "GatewayPlugin",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }
}
