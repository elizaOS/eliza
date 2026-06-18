import Foundation
import Combine

/// Connection state for the agent WebSocket.
enum AgentConnectionState {
    case disconnected
    case connecting
    case connected(sessionId: String)
    case error(String)
}

/// URLSessionWebSocketTask-based WebSocket client connecting to an elizaOS agent.
///
/// Binary frame protocol (from plugin-facewear protocol.ts):
///   bytes 0–3  big-endian uint32 — JSON header length
///   bytes 4–N  UTF-8 JSON header
///   bytes N+1… raw binary payload (audio PCM/Opus, JPEG, etc.)
///
/// Text frames are JSON control messages.
@MainActor
final class AgentConnection: NSObject, ObservableObject {
    @Published private(set) var state: AgentConnectionState = .disconnected
    @Published private(set) var lastAgentText: String = ""
    @Published private(set) var lastTranscript: String = ""

    /// Called with raw TTS audio binary frame bytes for playback.
    var onTTSAudio: ((Data) -> Void)?

    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession!
    private var sessionId: String = UUID().uuidString
    private var config: ConnectionConfig

    init(config: ConnectionConfig) {
        self.config = config
        super.init()
        self.session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    func connect() {
        guard let url = config.webSocketUrl else {
            state = .error("Invalid agent URL: \(config.agentUrl)")
            return
        }
        state = .connecting
        let task = session.webSocketTask(with: url)
        webSocketTask = task
        task.resume()
        sendHello()
        scheduleReceive()
    }

    func disconnect() {
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        state = .disconnected
    }

    // MARK: - Sending

    func sendControl(_ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8) else { return }
        webSocketTask?.send(.string(text)) { _ in }
    }

    /// Send a binary frame with 4-byte big-endian JSON header prefix.
    func sendBinaryFrame(header: [String: Any], payload: Data) {
        guard let headerData = try? JSONSerialization.data(withJSONObject: header) else { return }
        var frame = Data(capacity: 4 + headerData.count + payload.count)
        var len = UInt32(headerData.count).bigEndian
        withUnsafeBytes(of: &len) { frame.append(contentsOf: $0) }
        frame.append(headerData)
        frame.append(payload)
        webSocketTask?.send(.data(frame)) { _ in }
    }

    func sendPing() {
        sendControl(["type": "ping"])
    }

    // MARK: - Private

    private func sendHello() {
        sendControl([
            "type": "hello",
            "deviceType": "visionos",
            "sessionId": sessionId
        ])
    }

    private func scheduleReceive() {
        webSocketTask?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                Task { @MainActor in
                    self.handleMessage(message)
                    self.scheduleReceive()
                }
            case .failure(let error):
                Task { @MainActor in
                    self.state = .error(error.localizedDescription)
                }
            }
        }
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .string(let text):
            handleTextFrame(text)
        case .data(let data):
            handleBinaryFrame(data)
        @unknown default:
            break
        }
    }

    private func handleTextFrame(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type_ = json["type"] as? String else { return }

        switch type_ {
        case "ready":
            let sid = json["sessionId"] as? String ?? sessionId
            state = .connected(sessionId: sid)
        case "agent_text":
            lastAgentText = json["text"] as? String ?? ""
        case "transcript":
            if json["final"] as? Bool == true {
                lastTranscript = json["text"] as? String ?? ""
            }
        case "pong":
            break
        default:
            break
        }
    }

    private func handleBinaryFrame(_ data: Data) {
        guard data.count >= 4 else { return }
        let headerLen = Int(data[0]) << 24 | Int(data[1]) << 16 | Int(data[2]) << 8 | Int(data[3])
        guard data.count >= 4 + headerLen else { return }

        let headerData = data.subdata(in: 4..<(4 + headerLen))
        guard let json = try? JSONSerialization.jsonObject(with: headerData) as? [String: Any],
              let type_ = json["type"] as? String else { return }

        let payload = data.subdata(in: (4 + headerLen)..<data.count)
        if type_ == "tts_audio" {
            onTTSAudio?(payload)
        }
    }
}

extension AgentConnection: URLSessionWebSocketDelegate {
    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        // URLSession calls sendHello from connect() before this fires; no action needed.
    }

    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        Task { @MainActor [weak self] in
            self?.state = .disconnected
        }
    }
}
