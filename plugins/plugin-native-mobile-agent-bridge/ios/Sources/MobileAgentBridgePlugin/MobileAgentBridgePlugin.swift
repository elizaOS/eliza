import Foundation
import Capacitor
import WebKit

@objc(MobileAgentBridgePlugin)
public class MobileAgentBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MobileAgentBridgePlugin"
    public let jsName = "MobileAgentBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startInboundTunnel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopInboundTunnel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getTunnelStatus", returnType: CAPPluginReturnPromise),
    ]

    private var relayUrl: String?
    private var deviceId: String?
    private var pairingToken: String?
    private var state: String = "idle"
    private var lastError: String?
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?

    @objc func startInboundTunnel(_ call: CAPPluginCall) {
        guard let relay = call.getString("relayUrl")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !relay.isEmpty else {
            call.reject("MobileAgentBridge.startInboundTunnel requires relayUrl")
            return
        }
        guard let id = call.getString("deviceId")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !id.isEmpty else {
            call.reject("MobileAgentBridge.startInboundTunnel requires deviceId")
            return
        }

        stopTunnel(notify: false)
        relayUrl = relay
        deviceId = id
        pairingToken = call.getString("pairingToken")?.trimmingCharacters(in: .whitespacesAndNewlines)

        guard let url = buildRelayUrl(relayUrl: relay, deviceId: id, token: pairingToken) else {
            transition("error", reason: "Invalid relay URL: \(relay)")
            call.resolve(status())
            return
        }

        transition("connecting", reason: nil)
        let session = URLSession(configuration: .default)
        let task = session.webSocketTask(with: url)
        self.session = session
        self.task = task
        task.resume()
        receiveLoop()
        sendFrame([
            "type": "tunnel.register",
            "role": "phone-agent",
            "deviceId": id,
            "pairingToken": pairingToken ?? NSNull(),
        ]) { [weak self] error in
            if let error {
                self?.transition("error", reason: error.localizedDescription)
            } else {
                self?.transition("registered", reason: nil)
            }
        }
        call.resolve(status())
    }

    @objc func stopInboundTunnel(_ call: CAPPluginCall) {
        stopTunnel(notify: true)
        call.resolve()
    }

    @objc func getTunnelStatus(_ call: CAPPluginCall) {
        call.resolve(status())
    }

    private func stopTunnel(notify: Bool) {
        task?.cancel(with: .normalClosure, reason: nil)
        session?.invalidateAndCancel()
        task = nil
        session = nil
        relayUrl = nil
        deviceId = nil
        pairingToken = nil
        lastError = nil
        state = "idle"
        if notify {
            notifyListeners("stateChange", data: ["state": "idle"])
        }
    }

    private func transition(_ next: String, reason: String?) {
        state = next
        lastError = next == "error" ? reason : nil
        var event: [String: Any] = ["state": next]
        if let reason { event["reason"] = reason }
        notifyListeners("stateChange", data: event)
    }

    private func status() -> [String: Any] {
        [
            "state": state,
            "relayUrl": relayUrl ?? NSNull(),
            "deviceId": deviceId ?? NSNull(),
            "lastError": lastError ?? NSNull(),
        ]
    }

    private func buildRelayUrl(relayUrl: String, deviceId: String, token: String?) -> URL? {
        guard var components = URLComponents(string: relayUrl) else { return nil }
        if components.scheme == "https" { components.scheme = "wss" }
        if components.scheme == "http" { components.scheme = "ws" }
        var items = components.queryItems ?? []
        items.removeAll { $0.name == "deviceId" || $0.name == "token" }
        items.append(URLQueryItem(name: "deviceId", value: deviceId))
        if let token, !token.isEmpty {
            items.append(URLQueryItem(name: "token", value: token))
        }
        components.queryItems = items
        return components.url
    }

    private func receiveLoop() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                self.handle(message)
                self.receiveLoop()
            case .failure(let error):
                if self.task != nil {
                    self.transition("error", reason: error.localizedDescription)
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let text: String
        switch message {
        case .string(let value):
            text = value
        case .data(let data):
            text = String(data: data, encoding: .utf8) ?? ""
        @unknown default:
            return
        }
        guard let data = text.data(using: .utf8),
              let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }
        let type = frame["type"] as? String
        guard type == "http_request" || type == "tunnel.http_request" || type == "agent.http_request" else {
            return
        }
        proxyHttpRequest(frame)
    }

    private func proxyHttpRequest(_ frame: [String: Any]) {
        let id = frame["id"] ?? NSNull()
        let path = (frame["path"] as? String) ?? "/api/health"
        guard path.starts(with: "/"), !path.starts(with: "//"), !path.contains("://") else {
            sendFrame(["type": "http_response", "id": id, "status": 400, "headers": [:], "body": "Invalid local path"])
            return
        }
        let method = ((frame["method"] as? String) ?? "GET").uppercased()
        let headers = frame["headers"] as? [String: String] ?? [:]
        let body = frame["body"] is NSNull ? nil : frame["body"] as? String
        let timeoutMs = frame["timeoutMs"] as? Int ?? frame["timeout_ms"] as? Int ?? 30000
        let options: [String: Any] = [
            "method": method,
            "path": path,
            "headers": headers,
            "body": body ?? NSNull(),
            "timeoutMs": timeoutMs,
        ]
        dispatchLocalRequest(options) { [weak self] response in
            var out = response
            out["type"] = "http_response"
            out["id"] = id
            self?.sendFrame(out)
        }
    }

    private func dispatchLocalRequest(_ options: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        guard let webView = bridge?.webView else {
            completion(["status": 0, "headers": [:], "body": "", "error": "WebView unavailable"])
            return
        }
        let body = """
        if (typeof window.__ELIZA_IOS_LOCAL_AGENT_REQUEST__ !== "function") {
          throw new Error("iOS local agent IPC bridge is unavailable");
        }
        return await window.__ELIZA_IOS_LOCAL_AGENT_REQUEST__(options);
        """
        DispatchQueue.main.async {
            webView.callAsyncJavaScript(body, arguments: ["options": options], in: nil, in: .page) { result in
                switch result {
                case .success(let value):
                    if let dict = value as? [String: Any] {
                        completion(dict)
                    } else {
                        completion(["status": 0, "headers": [:], "body": "", "error": "Invalid IPC response"])
                    }
                case .failure(let error):
                    completion(["status": 0, "headers": [:], "body": "", "error": error.localizedDescription])
                }
            }
        }
    }

    private func sendFrame(_ frame: [String: Any], completion: ((Error?) -> Void)? = nil) {
        guard let task else {
            completion?(NSError(
                domain: "MobileAgentBridge",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "WebSocket is not connected"]
            ))
            return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8) else {
            completion?(NSError(
                domain: "MobileAgentBridge",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Failed to encode tunnel frame"]
            ))
            return
        }
        task.send(.string(text)) { [weak self] error in
            if let error {
                self?.transition("error", reason: error.localizedDescription)
            }
            completion?(error)
        }
    }
}
