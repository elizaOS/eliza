import AppKit
import SwiftUI

struct WindowTransparencyBridge: NSViewRepresentable {
    let isTransparent: Bool

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        DispatchQueue.main.async {
            apply(to: view.window)
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            apply(to: nsView.window)
        }
    }

    private func apply(to window: NSWindow?) {
        guard let window else {
            return
        }

        if isTransparent {
            window.styleMask = [.borderless, .resizable]
            window.isOpaque = false
            window.backgroundColor = .clear
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.isMovableByWindowBackground = true
            window.hasShadow = false
            window.contentView?.wantsLayer = true
            window.contentView?.layer?.backgroundColor = NSColor.clear.cgColor
        } else {
            window.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
            window.isOpaque = true
            window.backgroundColor = .windowBackgroundColor
            window.titlebarAppearsTransparent = false
            window.titleVisibility = .visible
            window.isMovableByWindowBackground = false
            window.hasShadow = true
            window.contentView?.layer?.backgroundColor = nil
        }

        setStandardWindowButtons(hidden: isTransparent, window: window)
    }

    private func setStandardWindowButtons(hidden: Bool, window: NSWindow) {
        [
            NSWindow.ButtonType.closeButton,
            .miniaturizeButton,
            .zoomButton
        ].forEach { buttonType in
            window.standardWindowButton(buttonType)?.isHidden = hidden
        }
    }
}
