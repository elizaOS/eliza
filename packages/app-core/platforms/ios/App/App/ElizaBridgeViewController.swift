/**
 Hosts the Capacitor WebView, installs document-start tracing, and registers
 app-target native plugins before the renderer requests their bridge surface.
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
        guard let bridge else {
            preconditionFailure("Capacitor bridge is unavailable during native plugin registration")
        }

        // App-target Swift plugins are not part of Capacitor's generated
        // packageClassList, so this instance must be registered explicitly.
        bridge.registerPluginInstance(ElizaWebAuthenticationPlugin())
        NSLog("[ElizaStartupTrace] iOS startupTraceId=%@", ElizaStartupTrace.currentId)
    }
}
