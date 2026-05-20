import SwiftUI
import AVFoundation

@main
struct ElizaFacewearApp: App {
    @StateObject private var config = ConnectionConfig()
    @StateObject private var agentConnection: AgentConnection

    init() {
        let cfg = ConnectionConfig()
        _config = StateObject(wrappedValue: cfg)
        _agentConnection = StateObject(wrappedValue: AgentConnection(config: cfg))
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(config)
                .environmentObject(agentConnection)
        }
        .windowStyle(.plain)

        ImmersiveSpace(id: "ElizaXRSpace") {
            ImmersiveSpaceView()
                .environmentObject(config)
                .environmentObject(agentConnection)
        }
        .immersionStyle(selection: .constant(.mixed), in: .mixed)
    }
}

/// Immersive space entry point — renders XR view panels in the user's environment.
struct ImmersiveSpaceView: View {
    @EnvironmentObject var config: ConnectionConfig
    @EnvironmentObject var agentConnection: AgentConnection
    @State private var cameraAudioBridge: CameraAudioBridge?
    @State private var ttsPlayer: AVAudioPlayer?

    var body: some View {
        XRViewRenderer(agentBaseUrl: config.agentUrl)
            .onAppear {
                setupBridges()
            }
            .onDisappear {
                cameraAudioBridge?.stop()
            }
    }

    private func setupBridges() {
        let bridge = CameraAudioBridge(connection: agentConnection)
        cameraAudioBridge = bridge

        agentConnection.onTTSAudio = { [weak self] audioData in
            Task { @MainActor in
                self?.playTTSAudio(audioData)
            }
        }

        bridge.start()
    }

    private func playTTSAudio(_ data: Data) {
        do {
            ttsPlayer = try AVAudioPlayer(data: data)
            ttsPlayer?.play()
        } catch {
            // TTS audio decoding failed — non-fatal
        }
    }
}
