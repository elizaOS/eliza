import UIKit

private enum ElizaKeyboardStore {
    static let pendingRequestKey = "com.elizaos.keyboard.pendingRequest"
    static let completedTranscriptKey = "com.elizaos.keyboard.completedTranscript"

    static var appGroupIdentifier: String {
        let bundleIdentifier = Bundle.main.bundleIdentifier ?? "ai.elizaos.app.ElizaKeyboard"
        let appBundleIdentifier = bundleIdentifier.replacingOccurrences(
            of: ".ElizaKeyboard",
            with: ""
        )
        return "group.\(appBundleIdentifier)"
    }

    static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroupIdentifier)
    }
}

final class KeyboardViewController: UIInputViewController {
    private let accentColor = UIColor(red: 1.0, green: 0.345, blue: 0.0, alpha: 1.0)
    private let statusLabel = UILabel()
    private var pendingRequestId: String?
    private var transcriptPoller: Timer?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        buildKeyboard()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        pollCompletedTranscript()
        startTranscriptPolling()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        transcriptPoller?.invalidate()
        transcriptPoller = nil
    }

    private func buildKeyboard() {
        let root = UIStackView()
        root.axis = .vertical
        root.spacing = 7
        root.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(root)

        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
            root.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8),
            root.topAnchor.constraint(equalTo: view.topAnchor, constant: 8),
            root.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -8),
        ])

        root.addArrangedSubview(makeSuggestionStrip())
        for row in ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"] {
            root.addArrangedSubview(makeLetterRow(row.map(String.init)))
        }
        root.addArrangedSubview(makeCommandRow())
    }

    private func makeSuggestionStrip() -> UIView {
        let strip = UIStackView()
        strip.axis = .horizontal
        strip.spacing = 6
        strip.distribution = .fillEqually

        statusLabel.text = "Eliza Keyboard"
        statusLabel.textAlignment = .center
        statusLabel.font = .preferredFont(forTextStyle: .caption1)
        statusLabel.textColor = .secondaryLabel

        strip.addArrangedSubview(makeSuggestionButton("Ask", text: "Ask Eliza "))
        strip.addArrangedSubview(makeSuggestionButton("Reply", text: "Reply: "))
        strip.addArrangedSubview(makeSuggestionButton("Task", text: "Task: "))
        strip.addArrangedSubview(statusLabel)
        return strip
    }

    private func makeLetterRow(_ letters: [String]) -> UIView {
        let row = UIStackView()
        row.axis = .horizontal
        row.spacing = 5
        row.distribution = .fillEqually
        for letter in letters {
            row.addArrangedSubview(makeKey(letter) { [weak self] in
                self?.textDocumentProxy.insertText(letter.lowercased())
            })
        }
        return row
    }

    private func makeCommandRow() -> UIView {
        let row = UIStackView()
        row.axis = .horizontal
        row.spacing = 5
        row.distribution = .fill

        let next = makeKey("Next") { [weak self] in self?.advanceToNextInputMode() }
        let dictate = makeKey("Dictate") { [weak self] in self?.openContainingAppForDictation() }
        let space = makeKey("space") { [weak self] in self?.textDocumentProxy.insertText(" ") }
        let delete = makeKey("Delete") { [weak self] in self?.textDocumentProxy.deleteBackward() }
        let enter = makeKey("return") { [weak self] in self?.textDocumentProxy.insertText("\n") }

        next.widthAnchor.constraint(equalToConstant: 50).isActive = true
        delete.widthAnchor.constraint(equalToConstant: 66).isActive = true
        enter.widthAnchor.constraint(equalToConstant: 70).isActive = true
        dictate.widthAnchor.constraint(greaterThanOrEqualToConstant: 86).isActive = true

        row.addArrangedSubview(next)
        row.addArrangedSubview(dictate)
        row.addArrangedSubview(space)
        row.addArrangedSubview(delete)
        row.addArrangedSubview(enter)
        return row
    }

    private func makeSuggestionButton(_ title: String, text: String) -> UIButton {
        makeKey(title) { [weak self] in
            self?.textDocumentProxy.insertText(text)
        }
    }

    private func makeKey(_ title: String, action: @escaping () -> Void) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.titleLabel?.font = .preferredFont(forTextStyle: .body)
        button.backgroundColor = .secondarySystemGroupedBackground
        button.tintColor = title == "Dictate" ? accentColor : .label
        button.layer.cornerRadius = 7
        button.contentEdgeInsets = UIEdgeInsets(top: 8, left: 6, bottom: 8, right: 6)
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
        return button
    }

    private func openContainingAppForDictation() {
        let requestId = UUID().uuidString
        pendingRequestId = requestId
        let payload: [String: Any] = [
            "requestId": requestId,
            "requestedAt": ISO8601DateFormatter().string(from: Date()),
            "source": "ios-keyboard",
        ]
        ElizaKeyboardStore.defaults?.set(payload, forKey: ElizaKeyboardStore.pendingRequestKey)
        ElizaKeyboardStore.defaults?.synchronize()
        statusLabel.text = "Listening in Eliza..."

        var components = URLComponents()
        components.scheme = "elizaos"
        components.host = "keyboard-dictation"
        components.queryItems = [
            URLQueryItem(name: "source", value: "ios-keyboard"),
            URLQueryItem(name: "action", value: "keyboard.dictation"),
            URLQueryItem(name: "voice", value: "1"),
            URLQueryItem(name: "requestId", value: requestId),
        ]
        guard let url = components.url else { return }
        extensionContext?.open(url, completionHandler: nil)
    }

    private func startTranscriptPolling() {
        transcriptPoller?.invalidate()
        transcriptPoller = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.pollCompletedTranscript()
        }
    }

    private func pollCompletedTranscript() {
        guard
            let defaults = ElizaKeyboardStore.defaults,
            let payload = defaults.dictionary(forKey: ElizaKeyboardStore.completedTranscriptKey),
            let transcript = (payload["transcript"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
            !transcript.isEmpty
        else {
            return
        }
        let completedRequestId = payload["requestId"] as? String
        if let pendingRequestId, completedRequestId != pendingRequestId {
            return
        }

        textDocumentProxy.insertText(transcript)
        defaults.removeObject(forKey: ElizaKeyboardStore.completedTranscriptKey)
        defaults.removeObject(forKey: ElizaKeyboardStore.pendingRequestKey)
        defaults.synchronize()
        self.pendingRequestId = nil
        statusLabel.text = "Inserted"
    }
}
