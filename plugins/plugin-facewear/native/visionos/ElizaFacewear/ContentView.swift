import SwiftUI
import RealityKit

/// Main content view.
///
/// Shows connection setup when disconnected. Once connected, offers the choice
/// between immersive space (RealityKit XR panels) and WebXR mode (WKWebView PWA).
struct ContentView: View {
    @EnvironmentObject var config: ConnectionConfig
    @EnvironmentObject var agentConnection: AgentConnection
    @Environment(\.openImmersiveSpace) var openImmersiveSpace
    @Environment(\.dismissImmersiveSpace) var dismissImmersiveSpace

    @State private var isImmersiveSpaceOpen = false
    @State private var showWebXR = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                headerView
                connectionSection
                if case .connected = agentConnection.state {
                    actionsSection
                }
                statusSection
            }
            .padding(32)
            .navigationTitle("Eliza Facewear")
        }
    }

    // MARK: - Subviews

    private var headerView: some View {
        VStack(spacing: 8) {
            Image(systemName: "eye.fill")
                .font(.system(size: 48))
                .foregroundStyle(.tint)
            Text("elizaOS Vision Pro")
                .font(.largeTitle)
                .fontWeight(.bold)
        }
    }

    private var connectionSection: some View {
        GroupBox("Agent Connection") {
            VStack(alignment: .leading, spacing: 12) {
                TextField("Agent URL", text: $config.agentUrl)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)

                TextField("Device Name", text: $config.deviceName)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()

                Button(isConnected ? "Disconnect" : "Connect") {
                    isConnected ? agentConnection.disconnect() : agentConnection.connect()
                }
                .buttonStyle(.borderedProminent)
                .disabled(config.agentUrl.isEmpty)
            }
        }
    }

    private var actionsSection: some View {
        GroupBox("Immersive Modes") {
            VStack(spacing: 12) {
                Button("Open XR Space") {
                    Task {
                        if isImmersiveSpaceOpen {
                            await dismissImmersiveSpace()
                            isImmersiveSpaceOpen = false
                        } else {
                            await openImmersiveSpace(id: "ElizaXRSpace")
                            isImmersiveSpaceOpen = true
                        }
                    }
                }
                .buttonStyle(.bordered)

                Button(showWebXR ? "Close WebXR" : "Open WebXR") {
                    showWebXR.toggle()
                }
                .buttonStyle(.bordered)
                .sheet(isPresented: $showWebXR) {
                    if let pwaUrl = config.pwaUrl {
                        WebXRView(url: pwaUrl)
                            .ignoresSafeArea()
                    }
                }
            }
        }
    }

    private var statusSection: some View {
        GroupBox("Status") {
            VStack(alignment: .leading, spacing: 8) {
                Label(connectionStateText, systemImage: connectionStateIcon)
                    .foregroundStyle(connectionStateColor)
                if !agentConnection.lastAgentText.isEmpty {
                    Text("Agent: \(agentConnection.lastAgentText)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                if !agentConnection.lastTranscript.isEmpty {
                    Text("You: \(agentConnection.lastTranscript)")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(2)
                }
            }
        }
    }

    // MARK: - Helpers

    private var isConnected: Bool {
        if case .connected = agentConnection.state { return true }
        return false
    }

    private var connectionStateText: String {
        switch agentConnection.state {
        case .disconnected: return "Disconnected"
        case .connecting: return "Connecting…"
        case .connected(let sid): return "Connected — \(sid.prefix(8))…"
        case .error(let msg): return "Error: \(msg)"
        }
    }

    private var connectionStateIcon: String {
        switch agentConnection.state {
        case .disconnected: return "wifi.slash"
        case .connecting: return "wifi.exclamationmark"
        case .connected: return "wifi"
        case .error: return "exclamationmark.triangle"
        }
    }

    private var connectionStateColor: Color {
        switch agentConnection.state {
        case .disconnected: return .secondary
        case .connecting: return .orange
        case .connected: return .green
        case .error: return .red
        }
    }
}
