/**
 The iOS bridge view controller installs document-start tracing and registers
 every Capacitor plugin compiled directly into the App target.
 */
import Capacitor
import WebKit

@objc(ElizaBridgeViewController)
class ElizaBridgeViewController: CAPBridgeViewController {
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        configuration.userContentController.addUserScript(
            WKUserScript(
                source: ElizaStartupTrace.documentStartScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        return configuration
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // App-target plugins never appear in cap-sync's packageClassList, so
        // this controller is their single registration authority. Missing one
        // leaves its JS proxy present but permanently unavailable at runtime.
        bridge?.registerPluginInstance(GlassBridge())
        bridge?.registerPluginInstance(ElizaIntentPlugin())
        bridge?.registerPluginInstance(ElizaKeyboardPlugin())
        bridge?.registerPluginInstance(ElizaLiveActivityPlugin())
        bridge?.registerPluginInstance(NativeTranscriptPlugin())
        NSLog("[ElizaStartupTrace] iOS startupTraceId=%@", ElizaStartupTrace.currentId)
    }
}
