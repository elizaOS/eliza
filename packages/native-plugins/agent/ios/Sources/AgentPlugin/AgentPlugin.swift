import Foundation
import Capacitor

private let maxRequestBodyBytes = 10 * 1024 * 1024
private let maxResponseBodyBytes = 10 * 1024 * 1024

private struct AgentEndpoint {
    let baseURL: URL
    let token: String?
}

private struct AgentHTTPResponse {
    let status: Int
    let statusText: String
    let headers: [String: String]
    let body: String
}

/// Eliza Agent Plugin — iOS HTTP bridge.
///
/// iOS does not bundle a Bun runtime. This plugin bridges the Capacitor
/// Agent API to an explicitly configured HTTP agent endpoint, such as a
/// local Mac dev server or a remote Eliza agent. Without that endpoint it
/// fails with an actionable error instead of pretending a local agent exists.
@objc(AgentPlugin)
public class AgentPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgentPlugin"
    public let jsName = "Agent"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "chat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLocalAgentToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
    ]

    private static var conversationIdByBaseURL: [String: String] = [:]

    @objc func start(_ call: CAPPluginCall) {
        guard let endpoint = resolveEndpoint(call: call) else {
            call.reject(missingEndpointMessage())
            return
        }

        sendJSON(endpoint: endpoint, path: "/api/agent/start", method: "POST", timeoutMs: timeoutMs(from: call)) { result in
            switch result {
            case .success(let response):
                guard self.isHTTPSuccess(response.status) else {
                    call.reject(self.httpErrorMessage(prefix: "Agent start failed", response: response))
                    return
                }
                let payload = self.parseJSONObject(response.body)
                let statusPayload = (payload?["status"] as? JSObject) ?? payload ?? [:]
                call.resolve(self.normalizedStatus(statusPayload, fallbackState: "running", endpoint: endpoint, error: nil))
            case .failure(let error):
                call.reject("Agent start failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        guard let endpoint = resolveEndpoint(call: call) else {
            call.reject(missingEndpointMessage())
            return
        }

        sendJSON(endpoint: endpoint, path: "/api/agent/stop", method: "POST", timeoutMs: timeoutMs(from: call)) { result in
            switch result {
            case .success(let response):
                guard self.isHTTPSuccess(response.status) else {
                    call.reject(self.httpErrorMessage(prefix: "Agent stop failed", response: response))
                    return
                }
                let payload = self.parseJSONObject(response.body)
                let ok = (payload?["ok"] as? Bool) ?? true
                call.resolve(["ok": ok])
            case .failure(let error):
                call.reject("Agent stop failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        guard let endpoint = resolveEndpoint(call: call) else {
            call.resolve(status(state: "error", agentName: nil, port: nil, startedAt: nil, error: missingEndpointMessage()))
            return
        }

        sendJSON(endpoint: endpoint, path: "/api/status", method: "GET", timeoutMs: timeoutMs(from: call, defaultValue: 1_500)) { result in
            switch result {
            case .success(let response):
                guard self.isHTTPSuccess(response.status) else {
                    call.resolve(self.status(
                        state: "error",
                        agentName: nil,
                        port: self.port(from: endpoint.baseURL),
                        startedAt: nil,
                        error: self.httpErrorMessage(prefix: "Agent status unavailable", response: response)
                    ))
                    return
                }
                let payload = self.parseJSONObject(response.body) ?? [:]
                call.resolve(self.normalizedStatus(payload, fallbackState: "running", endpoint: endpoint, error: nil))
            case .failure(let error):
                call.resolve(self.status(
                    state: "error",
                    agentName: nil,
                    port: self.port(from: endpoint.baseURL),
                    startedAt: nil,
                    error: "Agent status unavailable: \(error.localizedDescription)"
                ))
            }
        }
    }

    @objc func chat(_ call: CAPPluginCall) {
        guard let text = call.getString("text")?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            call.reject("Agent.chat requires non-empty text")
            return
        }
        guard let endpoint = resolveEndpoint(call: call) else {
            call.reject(missingEndpointMessage())
            return
        }

        ensureConversation(endpoint: endpoint, timeoutMs: timeoutMs(from: call)) { conversationResult in
            switch conversationResult {
            case .success(let conversationId):
                self.sendChatMessage(endpoint: endpoint, conversationId: conversationId, text: text, timeoutMs: self.timeoutMs(from: call), retryOnMissingConversation: true) { result in
                    switch result {
                    case .success(let payload):
                        call.resolve(payload)
                    case .failure(let error):
                        call.reject(error.localizedDescription)
                    }
                }
            case .failure(let error):
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func getLocalAgentToken(_ call: CAPPluginCall) {
        let token = resolveEndpoint(call: call)?.token
        call.resolve([
            "available": token != nil,
            "token": token ?? NSNull(),
        ])
    }

    @objc func request(_ call: CAPPluginCall) {
        guard let endpoint = resolveEndpoint(call: call) else {
            call.reject(missingEndpointMessage())
            return
        }
        guard let path = call.getString("path")?.trimmingCharacters(in: .whitespacesAndNewlines),
              isSafeLocalPath(path) else {
            call.reject("Agent.request requires a local path that starts with / and is not an absolute URL")
            return
        }
        let method = (call.getString("method") ?? "GET").trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard method.range(of: "^[A-Z]{1,16}$", options: .regularExpression) != nil else {
            call.reject("Unsupported HTTP method")
            return
        }
        let body = call.getString("body")
        if let bodyBytes = body?.data(using: .utf8), bodyBytes.count > maxRequestBodyBytes {
            call.reject("Request body is too large")
            return
        }

        let headers = call.getObject("headers") ?? [:]
        sendJSON(
            endpoint: endpoint,
            path: path,
            method: method,
            headers: headers,
            body: body,
            timeoutMs: timeoutMs(from: call)
        ) { result in
            switch result {
            case .success(let response):
                call.resolve([
                    "status": response.status,
                    "statusText": response.statusText,
                    "headers": response.headers,
                    "body": response.body,
                ])
            case .failure(let error):
                call.reject("Local agent request failed: \(error.localizedDescription)")
            }
        }
    }

    private func ensureConversation(
        endpoint: AgentEndpoint,
        timeoutMs: Int,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        let baseKey = endpoint.baseURL.absoluteString
        if let existing = Self.conversationIdByBaseURL[baseKey], !existing.isEmpty {
            completion(.success(existing))
            return
        }

        sendJSON(
            endpoint: endpoint,
            path: "/api/conversations",
            method: "POST",
            headers: ["Content-Type": "application/json"],
            body: "{\"title\":\"Quick Chat\"}",
            timeoutMs: timeoutMs
        ) { result in
            switch result {
            case .success(let response):
                guard self.isHTTPSuccess(response.status) else {
                    completion(.failure(self.pluginError(self.httpErrorMessage(prefix: "Failed to create conversation", response: response))))
                    return
                }
                guard let payload = self.parseJSONObject(response.body),
                      let conversation = payload["conversation"] as? JSObject,
                      let id = conversation["id"] as? String,
                      !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    completion(.failure(self.pluginError("Conversation create response missing id")))
                    return
                }
                Self.conversationIdByBaseURL[baseKey] = id
                completion(.success(id))
            case .failure(let error):
                completion(.failure(self.pluginError("Failed to create conversation: \(error.localizedDescription)")))
            }
        }
    }

    private func sendChatMessage(
        endpoint: AgentEndpoint,
        conversationId: String,
        text: String,
        timeoutMs: Int,
        retryOnMissingConversation: Bool,
        completion: @escaping (Result<JSObject, Error>) -> Void
    ) {
        let path = "/api/conversations/\(urlEncode(conversationId))/messages"
        let bodyObject: JSObject = [
            "text": text,
            "channelType": "DM",
        ]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: bodyObject, options: []),
              let body = String(data: bodyData, encoding: .utf8) else {
            completion(.failure(pluginError("Failed to encode chat request")))
            return
        }

        sendJSON(
            endpoint: endpoint,
            path: path,
            method: "POST",
            headers: ["Content-Type": "application/json"],
            body: body,
            timeoutMs: timeoutMs
        ) { result in
            switch result {
            case .success(let response):
                if response.status == 404 && retryOnMissingConversation {
                    Self.conversationIdByBaseURL.removeValue(forKey: endpoint.baseURL.absoluteString)
                    self.ensureConversation(endpoint: endpoint, timeoutMs: timeoutMs) { nextConversation in
                        switch nextConversation {
                        case .success(let nextId):
                            self.sendChatMessage(
                                endpoint: endpoint,
                                conversationId: nextId,
                                text: text,
                                timeoutMs: timeoutMs,
                                retryOnMissingConversation: false,
                                completion: completion
                            )
                        case .failure(let error):
                            completion(.failure(error))
                        }
                    }
                    return
                }
                guard self.isHTTPSuccess(response.status) else {
                    completion(.failure(self.pluginError(self.httpErrorMessage(prefix: "Chat request failed", response: response))))
                    return
                }
                let payload = self.parseJSONObject(response.body) ?? [:]
                let responseText = (payload["text"] as? String) ?? ""
                let agentName = (payload["agentName"] as? String) ?? "Agent"
                completion(.success([
                    "text": responseText,
                    "agentName": agentName,
                ]))
            case .failure(let error):
                completion(.failure(self.pluginError("Chat request failed: \(error.localizedDescription)")))
            }
        }
    }

    private func sendJSON(
        endpoint: AgentEndpoint,
        path: String,
        method: String,
        headers: JSObject = [:],
        body: String? = nil,
        timeoutMs: Int,
        completion: @escaping (Result<AgentHTTPResponse, Error>) -> Void
    ) {
        guard let url = URL(string: path, relativeTo: endpoint.baseURL)?.absoluteURL else {
            completion(.failure(pluginError("Invalid local agent request path")))
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = TimeInterval(timeoutMs) / 1_000
        request.cachePolicy = .reloadIgnoringLocalCacheData

        for (key, value) in headers {
            let normalizedKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !normalizedKey.isEmpty,
                  !isBlockedHeader(normalizedKey),
                  let stringValue = value as? String,
                  !stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                continue
            }
            request.setValue(stringValue, forHTTPHeaderField: normalizedKey)
        }

        if let token = endpoint.token, request.value(forHTTPHeaderField: "Authorization") == nil {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let body = body, method != "GET", method != "HEAD" {
            let bodyData = body.data(using: .utf8) ?? Data()
            if bodyData.count > maxRequestBodyBytes {
                completion(.failure(pluginError("Request body is too large")))
                return
            }
            request.httpBody = bodyData
            if request.value(forHTTPHeaderField: "Content-Type") == nil {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
        }

        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(.failure(error))
                return
            }
            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(self.pluginError("Agent endpoint returned a non-HTTP response")))
                return
            }
            let responseData = data ?? Data()
            if responseData.count > maxResponseBodyBytes {
                completion(.failure(self.pluginError("Response body is too large")))
                return
            }

            var responseHeaders: [String: String] = [:]
            for (key, value) in httpResponse.allHeaderFields {
                guard let headerKey = key as? String else { continue }
                responseHeaders[headerKey.lowercased()] = String(describing: value)
            }

            completion(.success(AgentHTTPResponse(
                status: httpResponse.statusCode,
                statusText: HTTPURLResponse.localizedString(forStatusCode: httpResponse.statusCode),
                headers: responseHeaders,
                body: String(data: responseData, encoding: .utf8) ?? ""
            )))
        }.resume()
    }

    private func resolveEndpoint(call: CAPPluginCall? = nil) -> AgentEndpoint? {
        guard let rawBaseURL = readConfiguredString(
            call: call,
            keys: [
                "apiBase",
                "baseUrl",
                "baseURL",
                "agentApiBase",
                "ELIZA_AGENT_API_BASE",
                "ELIZA_API_BASE",
                "MILADY_IOS_API_BASE",
                "MILADY_IOS_REMOTE_API_BASE",
                "MILADY_MOBILE_API_BASE",
                "VITE_MILADY_IOS_API_BASE",
                "VITE_MILADY_MOBILE_API_BASE",
                "VITE_ELIZA_IOS_API_BASE",
            ]
        ) else {
            return nil
        }

        let trimmed = rawBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let baseURL = URL(string: trimmed),
              let scheme = baseURL.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              baseURL.host != nil else {
            return nil
        }

        let token = readConfiguredString(
            call: call,
            keys: [
                "apiToken",
                "token",
                "agentApiToken",
                "ELIZA_AGENT_API_TOKEN",
                "ELIZA_API_TOKEN",
                "MILADY_IOS_API_TOKEN",
                "MILADY_IOS_REMOTE_API_TOKEN",
                "MILADY_MOBILE_API_TOKEN",
                "VITE_MILADY_IOS_API_TOKEN",
                "VITE_MILADY_MOBILE_API_TOKEN",
                "VITE_ELIZA_IOS_API_TOKEN",
            ]
        )

        return AgentEndpoint(baseURL: baseURL, token: token)
    }

    private func readConfiguredString(call: CAPPluginCall?, keys: [String]) -> String? {
        for key in keys {
            if let value = call?.getString(key)?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return value
            }
        }

        let pluginConfig = getConfig()
        for key in keys {
            if let value = pluginConfig.getString(key)?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return value
            }
        }

        for key in keys {
            if let value = Bundle.main.object(forInfoDictionaryKey: key) as? String {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
        }

        let environment = ProcessInfo.processInfo.environment
        for key in keys {
            if let value = environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return value
            }
        }

        let defaults = UserDefaults.standard
        for key in keys {
            if let value = defaults.string(forKey: key)?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return value
            }
        }

        return nil
    }

    private func normalizedStatus(
        _ payload: JSObject,
        fallbackState: String,
        endpoint: AgentEndpoint,
        error: String?
    ) -> JSObject {
        let state = (payload["state"] as? String) ?? fallbackState
        let agentName = payload["agentName"] as? String
        let startedAt = payload["startedAt"] as? Double
            ?? (payload["startedAt"] as? NSNumber)?.doubleValue
            ?? (payload["started_at"] as? NSNumber)?.doubleValue
        let rawError = error ?? payload["error"] as? String
        return status(
            state: state,
            agentName: agentName,
            port: (payload["port"] as? Int)
                ?? (payload["port"] as? NSNumber)?.intValue
                ?? port(from: endpoint.baseURL),
            startedAt: startedAt,
            error: rawError
        )
    }

    private func status(
        state: String,
        agentName: String?,
        port: Int?,
        startedAt: Double?,
        error: String?
    ) -> JSObject {
        return [
            "state": state,
            "agentName": agentName ?? NSNull(),
            "port": port ?? NSNull(),
            "startedAt": startedAt ?? NSNull(),
            "error": error ?? NSNull(),
        ]
    }

    private func timeoutMs(from call: CAPPluginCall, defaultValue: Int = 10_000) -> Int {
        let value = call.getInt("timeoutMs") ?? defaultValue
        return min(120_000, max(1_000, value))
    }

    private func port(from url: URL) -> Int? {
        if let port = url.port { return port }
        if url.scheme?.lowercased() == "http" { return 80 }
        if url.scheme?.lowercased() == "https" { return 443 }
        return nil
    }

    private func isSafeLocalPath(_ path: String) -> Bool {
        if !path.hasPrefix("/") || path.hasPrefix("//") { return false }
        if path.range(of: "^[a-zA-Z][a-zA-Z0-9+.-]*://", options: .regularExpression) != nil {
            return false
        }
        return true
    }

    private func isBlockedHeader(_ key: String) -> Bool {
        switch key.lowercased() {
        case "host", "connection", "content-length":
            return true
        default:
            return false
        }
    }

    private func isHTTPSuccess(_ status: Int) -> Bool {
        return status >= 200 && status < 300
    }

    private func parseJSONObject(_ body: String) -> JSObject? {
        guard let data = body.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data, options: []),
              let json = object as? JSObject else {
            return nil
        }
        return json
    }

    private func httpErrorMessage(prefix: String, response: AgentHTTPResponse) -> String {
        let body = response.body.trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty {
            return "\(prefix): HTTP \(response.status)"
        }
        return "\(prefix): HTTP \(response.status): \(body)"
    }

    private func missingEndpointMessage() -> String {
        return "iOS Agent requires a configured HTTP endpoint. Set Agent.apiBase in capacitor.config, an Info.plist/UserDefaults key such as MILADY_IOS_API_BASE or ELIZA_AGENT_API_BASE, or a simulator environment variable. iOS does not bundle a Bun local runtime."
    }

    private func urlEncode(_ value: String) -> String {
        return value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private func pluginError(_ message: String) -> NSError {
        return NSError(domain: "AgentPlugin", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
