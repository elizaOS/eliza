import SwiftUI
import WebKit

/// WKWebView embedded in SwiftUI for running the Eliza Facewear PWA in WebXR mode.
///
/// Injects window.__ELIZA_DEVICE_TYPE__ = 'visionos' so the PWA can adapt its
/// UI and use the appropriate WebXR reference space.
struct WebXRView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        // Enable WebXR APIs
        let preferences = WKWebpagePreferences()
        preferences.allowsContentJavaScript = true
        configuration.defaultWebpagePreferences = preferences

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.scrollView.isScrollEnabled = false
        webView.isOpaque = false
        webView.backgroundColor = .clear

        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if webView.url != url {
            let request = URLRequest(url: url)
            webView.load(request)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // Inject device-type hint after page load
            webView.evaluateJavaScript(
                "window.__ELIZA_DEVICE_TYPE__ = 'visionos';",
                completionHandler: nil
            )
        }
    }
}
