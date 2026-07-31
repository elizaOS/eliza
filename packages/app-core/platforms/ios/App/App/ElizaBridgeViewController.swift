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
        // In-app plugins (compiled into the App target, not npm packages)
        // never appear in the cap-sync-generated packageClassList, so they
        // must be registered here or the JS proxy silently reports them
        // unavailable. Discovered by the #15891 device lane: GlassBridge
        // compiled on iOS since the parity PR but was never reachable —
        // isNativeGlassAvailable() could only ever answer false.
        bridge?.registerPluginInstance(GlassBridge())
        NSLog("[ElizaStartupTrace] iOS startupTraceId=%@", ElizaStartupTrace.currentId)
    }
}
