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
        NSLog("[ElizaStartupTrace] iOS startupTraceId=%@", ElizaStartupTrace.currentId)
    }
}
