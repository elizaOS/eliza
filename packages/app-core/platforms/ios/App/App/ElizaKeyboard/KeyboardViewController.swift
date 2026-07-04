import UIKit

/// Voice-first custom keyboard (issue #12185, sub 3 — the Wispr pattern).
/// Keyboard extensions can never access the microphone, so the mic button
/// opens the containing app via `elizaos://keyboard-dictation?source=ios-keyboard`;
/// the app records + transcribes (native ASR), writes the transcript to the
/// App Group as an `ElizaKeyboardDictationState.Record`, and when the user
/// switches back this controller polls the record and inserts the text via
/// `textDocumentProxy`. Deliberately minimal — a status strip, a mic button,
/// and a utility row (globe/space/delete/return) — because the extension
/// memory budget is tiny and full typing stays on the user's main keyboard.
///
/// Every handoff outcome renders an explicit state: missing Full Access
/// (App Group reads require it), app-open failure, in-progress, transcript
/// inserted, and app-side errors (engine not running, ASR failure, no speech).
class KeyboardViewController: UIInputViewController {
    private enum HandoffUiState {
        case needsFullAccess
        case idle
        case opening
        case awaiting(ElizaKeyboardDictationState.Status)
        case inserted
        case failed(String)
    }

    private static let accentColor = UIColor(red: 1.0, green: 0.345, blue: 0.0, alpha: 1.0)
    private static let keyboardHeight: CGFloat = 216
    private static let pollIntervalSeconds: TimeInterval = 0.8

    private let statusLabel = UILabel()
    private let micButton = UIButton(type: .system)
    private let nextKeyboardButton = UIButton(type: .system)
    private var pollTimer: Timer?
    private var resetTimer: Timer?

    override func viewDidLoad() {
        super.viewDidLoad()
        buildLayout()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        nextKeyboardButton.isHidden = !needsInputModeSwitchKey
        refreshFromSharedState()
        startPolling()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopPolling()
        resetTimer?.invalidate()
        resetTimer = nil
    }

    // MARK: - Layout

    private func buildLayout() {
        view.heightAnchor.constraint(equalToConstant: Self.keyboardHeight).isActive = true
        view.backgroundColor = .clear

        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.textColor = .secondaryLabel
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 2
        statusLabel.adjustsFontSizeToFitWidth = true
        statusLabel.minimumScaleFactor = 0.7

        var micConfig = UIButton.Configuration.filled()
        micConfig.image = UIImage(
            systemName: "mic.fill",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 28, weight: .semibold)
        )
        micConfig.baseBackgroundColor = Self.accentColor
        micConfig.baseForegroundColor = .white
        micConfig.cornerStyle = .capsule
        micConfig.contentInsets = NSDirectionalEdgeInsets(top: 18, leading: 34, bottom: 18, trailing: 34)
        micButton.configuration = micConfig
        micButton.accessibilityLabel = "Dictate with Eliza"
        micButton.addTarget(self, action: #selector(micTapped), for: .touchUpInside)

        nextKeyboardButton.setImage(UIImage(systemName: "globe"), for: .normal)
        nextKeyboardButton.tintColor = .label
        nextKeyboardButton.accessibilityLabel = "Next keyboard"
        // The system-standard switch affordance: forwarding all touch events to
        // handleInputModeList also enables the long-press keyboard picker.
        nextKeyboardButton.addTarget(
            self,
            action: #selector(handleInputModeList(from:with:)),
            for: .allTouchEvents
        )

        let spaceButton = utilityButton(title: "space")
        spaceButton.addTarget(self, action: #selector(spaceTapped), for: .touchUpInside)
        let deleteButton = utilityButton(systemImage: "delete.left")
        deleteButton.accessibilityLabel = "Delete"
        deleteButton.addTarget(self, action: #selector(deleteTapped), for: .touchUpInside)
        let returnButton = utilityButton(systemImage: "return")
        returnButton.accessibilityLabel = "Return"
        returnButton.addTarget(self, action: #selector(returnTapped), for: .touchUpInside)

        let bottomRow = UIStackView(arrangedSubviews: [
            nextKeyboardButton, spaceButton, deleteButton, returnButton,
        ])
        bottomRow.axis = .horizontal
        bottomRow.spacing = 8
        bottomRow.distribution = .fillProportionally
        spaceButton.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let column = UIStackView(arrangedSubviews: [statusLabel, micButton, bottomRow])
        column.axis = .vertical
        column.alignment = .center
        column.spacing = 14
        column.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: view.topAnchor, constant: 12),
            column.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            column.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            column.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -10),
            bottomRow.leadingAnchor.constraint(equalTo: column.leadingAnchor),
            bottomRow.trailingAnchor.constraint(equalTo: column.trailingAnchor),
            bottomRow.heightAnchor.constraint(equalToConstant: 40),
        ])
    }

    private func utilityButton(title: String? = nil, systemImage: String? = nil) -> UIButton {
        let button = UIButton(type: .system)
        var config = UIButton.Configuration.gray()
        if let title {
            config.title = title
        }
        if let systemImage {
            config.image = UIImage(systemName: systemImage)
        }
        config.baseForegroundColor = .label
        config.cornerStyle = .medium
        button.configuration = config
        return button
    }

    // MARK: - Handoff state machine

    private func render(_ state: HandoffUiState) {
        switch state {
        case .needsFullAccess:
            statusLabel.text =
                "Allow Full Access for the Eliza keyboard in Settings › General › Keyboard to receive dictation."
            micButton.isEnabled = true
        case .idle:
            statusLabel.text = "Tap the mic — Eliza records in the app; swipe back to insert."
            micButton.isEnabled = true
        case .opening:
            statusLabel.text = "Opening Eliza…"
            micButton.isEnabled = false
        case .awaiting(let status):
            statusLabel.text = status == .transcribing
                ? "Transcribing in Eliza…"
                : "Listening in Eliza… finish speaking, then swipe back here."
            micButton.isEnabled = true
        case .inserted:
            statusLabel.text = "Transcript inserted."
            micButton.isEnabled = true
        case .failed(let message):
            statusLabel.text = message
            micButton.isEnabled = true
        }
    }

    private func refreshFromSharedState() {
        guard hasFullAccess else {
            render(.needsFullAccess)
            return
        }
        guard let record = ElizaKeyboardDictationState.load() else {
            render(.idle)
            return
        }
        guard ElizaKeyboardDictationState.isFresh(record) else {
            ElizaKeyboardDictationState.clear()
            render(.idle)
            return
        }
        switch record.status {
        case .recording, .transcribing:
            render(.awaiting(record.status))
        case .ready:
            let transcript = record.transcript?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            ElizaKeyboardDictationState.clear()
            if transcript.isEmpty {
                // A ready record without text is a broken pipeline — surface it.
                render(.failed("Eliza returned an empty transcript. Try again."))
            } else {
                textDocumentProxy.insertText(transcript)
                render(.inserted)
                scheduleIdleReset()
            }
        case .error:
            ElizaKeyboardDictationState.clear()
            let message = record.errorMessage?.trimmingCharacters(in: .whitespacesAndNewlines)
            render(.failed(message?.isEmpty == false ? message! : "Dictation failed in Eliza. Try again."))
        }
    }

    private func scheduleIdleReset() {
        resetTimer?.invalidate()
        resetTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            self?.render(.idle)
        }
    }

    private func startPolling() {
        stopPolling()
        pollTimer = Timer.scheduledTimer(
            withTimeInterval: Self.pollIntervalSeconds,
            repeats: true
        ) { [weak self] _ in
            guard let self, self.hasFullAccess else { return }
            guard let record = ElizaKeyboardDictationState.load() else { return }
            // Only completed states change what the strip already shows.
            if record.status == .ready || record.status == .error {
                self.refreshFromSharedState()
            } else if ElizaKeyboardDictationState.isFresh(record) {
                self.render(.awaiting(record.status))
            }
        }
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    // MARK: - Actions

    @objc private func micTapped() {
        guard hasFullAccess else {
            render(.needsFullAccess)
            return
        }
        // Drop any stale record so old text can't insert the moment we return.
        ElizaKeyboardDictationState.clear()

        var components = URLComponents()
        components.scheme = "elizaos"
        components.host = "keyboard-dictation"
        components.queryItems = [
            URLQueryItem(name: "source", value: "ios-keyboard"),
            URLQueryItem(name: "session", value: UUID().uuidString),
        ]
        guard let url = components.url else {
            render(.failed("Couldn't build the Eliza dictation link."))
            return
        }
        render(.opening)
        openContainingApp(url)
    }

    private func openContainingApp(_ url: URL) {
        if let extensionContext {
            extensionContext.open(url) { [weak self] success in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if success {
                        self.render(.awaiting(.recording))
                    } else if self.openViaResponderChain(url) {
                        self.render(.awaiting(.recording))
                    } else {
                        self.render(.failed("Couldn't open the Eliza app. Open it manually to dictate."))
                    }
                }
            }
            return
        }
        if openViaResponderChain(url) {
            render(.awaiting(.recording))
        } else {
            render(.failed("Couldn't open the Eliza app. Open it manually to dictate."))
        }
    }

    /// `NSExtensionContext.open` is honored inconsistently for keyboard
    /// extensions (the host app decides), so fall back to the responder-chain
    /// `openURL:` dispatch every shipping keyboard uses. Selector-based so the
    /// target compiles under APPLICATION_EXTENSION_API_ONLY.
    @discardableResult
    private func openViaResponderChain(_ url: URL) -> Bool {
        let selector = NSSelectorFromString("openURL:")
        var responder: UIResponder? = self
        while let current = responder {
            if current.responds(to: selector) {
                current.perform(selector, with: url)
                return true
            }
            responder = current.next
        }
        return false
    }

    @objc private func spaceTapped() {
        textDocumentProxy.insertText(" ")
    }

    @objc private func deleteTapped() {
        textDocumentProxy.deleteBackward()
    }

    @objc private func returnTapped() {
        textDocumentProxy.insertText("\n")
    }
}
