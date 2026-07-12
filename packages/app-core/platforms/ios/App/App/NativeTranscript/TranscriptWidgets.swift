import Foundation
import SwiftUI
import UIKit

/// SwiftUI widget matrix for the NativeTranscript renderer: one native view per
/// `NativeSegment` widget kind (choice, followups, form, workflow, checklist,
/// task, background) plus the permission payload card, the secretRequest form,
/// and labeled fallbacks for ui-spec/config segments. Contract source of truth:
/// `packages/ui/src/chat/native-transcript/spec.ts` and the golden fixture
/// `packages/ui/src/chat/native-transcript/__fixtures__/transcript-golden.json`.
///
/// Widgets draw only — behavior is the DOM widgets' string-action protocol,
/// emitted verbatim through the single `emit` closure (which the plugin relays
/// as the `transcriptAction` event; there is NO second action channel):
///   choice tap        → the option's `value` string (e.g. `__first_run__:…`)
///   followup tap      → the option's encoded `payload` string
///   form submit       → `[form:submit <formId>] {json-of-values}`
///   background swatch → `[background:set <presetId>]`
///   permission        → `__permission_card__:use_fallback feature=… permission=…`
///   secret submit     → `[secret:submit <key>]` (JS owns the real submission)
///
/// The pure-logic region below is Foundation-only by design: the sibling
/// `TranscriptWidgets.test.swift` script extracts it verbatim (between the
/// line-start pure-logic markers) and runs assertions against the golden
/// fixture, so keep decoders + action-string formatting inside the markers and
/// keep SwiftUI out of them.
///
/// Registration seam: `WidgetRegistry.registerBuiltins()` (extension at the
/// bottom) walks `transcriptBuiltinWidgetBuilders()` — a dictionary keyed by
/// widgetKind mapping `([String: Any], @escaping (String) -> Void) -> AnyView`.
/// The ios-core lane owns WidgetRegistry.swift / TranscriptListView.swift.

// PURE-LOGIC:BEGIN

// MARK: - Action-string protocol (mirror of spec.ts / sendActionMessage)

/// JSON string escaping identical to `JSON.stringify` so the native
/// `[form:submit …] {json}` payload is byte-compatible with the DOM widget's.
func transcriptJsonEscaped(_ value: String) -> String {
    var out = ""
    out.reserveCapacity(value.count)
    for scalar in value.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\u{08}": out += "\\b"
        case "\u{0C}": out += "\\f"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    return out
}

/// A submitted form field value: string for text/number/select/date/time/
/// datetime, boolean for checkbox — the same value domain as the DOM
/// `FormResultValue`.
enum TranscriptFormValue: Equatable {
    case string(String)
    case boolean(Bool)

    var jsonFragment: String {
        switch self {
        case .string(let s): return "\"\(transcriptJsonEscaped(s))\""
        case .boolean(let b): return b ? "true" : "false"
        }
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }
}

/// `[form:submit <formId>] {json}` with keys serialized in field order —
/// matching `JSON.stringify` over the DOM widget's insertion-ordered record.
func formSubmitActionString(
    formId: String,
    orderedValues: [(name: String, value: TranscriptFormValue)]
) -> String {
    let body = orderedValues
        .map { "\"\(transcriptJsonEscaped($0.name))\":\($0.value.jsonFragment)" }
        .joined(separator: ",")
    return "[form:submit \(formId)] {\(body)}"
}

func backgroundSetActionString(presetId: String) -> String {
    return "[background:set \(presetId)]"
}

func permissionFallbackActionString(feature: String, permission: String) -> String {
    return "__permission_card__:use_fallback feature=\(feature) permission=\(permission)"
}

func secretSubmitActionString(key: String) -> String {
    return "[secret:submit \(key)]"
}

/// Choice taps pass the option's `value` through unchanged (spec.ts: "choice
/// tap → the option's value string"). Kept as a named function so the
/// passthrough contract is testable and grep-able.
func choiceActionValue(optionValue: String) -> String {
    return optionValue
}

// MARK: - Form validation (parity with FormRequest + runValidation "required")

/// Mirror of the DOM `required` validator: `v != null && v !== ""` — empty
/// string fails, whitespace passes, checkboxes are never required-validated.
func transcriptRequiredSatisfied(_ value: TranscriptFormValue?) -> Bool {
    guard let value = value else { return false }
    switch value {
    case .string(let s): return !s.isEmpty
    case .boolean: return true
    }
}

func missingRequiredFieldNames(
    fields: [TranscriptFormFieldSpec],
    values: [String: TranscriptFormValue]
) -> [String] {
    var missing: [String] = []
    for field in fields where field.required && field.type != "checkbox" {
        if !transcriptRequiredSatisfied(values[field.name]) {
            missing.append(field.name)
        }
    }
    return missing
}

func requiredErrorMessage(for field: TranscriptFormFieldSpec) -> String {
    return "\(field.displayLabel) is required"
}

// MARK: - Widget data decoders (field names match the golden fixture exactly)

struct TranscriptChoiceOption: Equatable {
    let value: String
    let label: String
}

struct TranscriptChoiceData {
    let id: String
    let scope: String
    let options: [TranscriptChoiceOption]
    let allowCustom: Bool

    var isFirstRunScope: Bool { scope.hasPrefix("first-run") }

    init?(dict: [String: Any]) {
        guard let rawOptions = dict["options"] as? [[String: Any]] else { return nil }
        var options: [TranscriptChoiceOption] = []
        for raw in rawOptions {
            guard let value = raw["value"] as? String else { continue }
            options.append(TranscriptChoiceOption(
                value: value,
                label: (raw["label"] as? String) ?? value
            ))
        }
        let allowCustom = (dict["allowCustom"] as? Bool) ?? false
        if options.isEmpty && !allowCustom { return nil }
        self.id = (dict["id"] as? String) ?? ""
        self.scope = (dict["scope"] as? String) ?? ""
        self.options = options
        self.allowCustom = allowCustom
    }
}

struct TranscriptFollowupOption: Equatable {
    /// "reply" | "navigate" | "prompt"; unknown kinds degrade to reply,
    /// matching the DOM parser's default.
    let kind: String
    let payload: String
    let label: String
}

struct TranscriptFollowupsData {
    let id: String
    let options: [TranscriptFollowupOption]

    init?(dict: [String: Any]) {
        guard let rawOptions = dict["options"] as? [[String: Any]] else { return nil }
        var options: [TranscriptFollowupOption] = []
        for raw in rawOptions {
            guard let payload = raw["payload"] as? String,
                  let label = raw["label"] as? String else { continue }
            let rawKind = (raw["kind"] as? String) ?? "reply"
            let kind = ["reply", "navigate", "prompt"].contains(rawKind) ? rawKind : "reply"
            options.append(TranscriptFollowupOption(kind: kind, payload: payload, label: label))
        }
        if options.isEmpty { return nil }
        self.id = (dict["id"] as? String) ?? ""
        self.options = options
    }
}

struct TranscriptFormFieldSpec: Equatable {
    let name: String
    /// "text" | "number" | "select" | "checkbox" | "date" | "time" |
    /// "datetime"; unknown types degrade to text (parser parity).
    let type: String
    let label: String?
    let placeholder: String?
    let required: Bool
    let options: [TranscriptChoiceOption]

    var displayLabel: String { label ?? name }

    init?(dict: [String: Any]) {
        guard let name = dict["name"] as? String, !name.isEmpty else { return nil }
        let knownTypes = ["text", "number", "select", "checkbox", "date", "time", "datetime"]
        let rawType = (dict["type"] as? String) ?? "text"
        self.name = name
        self.type = knownTypes.contains(rawType) ? rawType : "text"
        self.label = dict["label"] as? String
        self.placeholder = dict["placeholder"] as? String
        self.required = (dict["required"] as? Bool) ?? false
        var options: [TranscriptChoiceOption] = []
        if let rawOptions = dict["options"] as? [[String: Any]] {
            for raw in rawOptions {
                guard let value = raw["value"] as? String else { continue }
                options.append(TranscriptChoiceOption(
                    value: value,
                    label: (raw["label"] as? String) ?? value
                ))
            }
        }
        self.options = options
    }
}

struct TranscriptFormSpec {
    let id: String
    let title: String?
    let description: String?
    let submitLabel: String
    let fields: [TranscriptFormFieldSpec]

    /// Widget data arrives as `{ start, end, form: {…} }` — the spec lives
    /// under the `form` key (fixture parity).
    init?(widgetData: [String: Any]) {
        guard let form = widgetData["form"] as? [String: Any] else { return nil }
        self.init(dict: form)
    }

    init?(dict: [String: Any]) {
        guard let rawFields = dict["fields"] as? [[String: Any]] else { return nil }
        var fields: [TranscriptFormFieldSpec] = []
        for raw in rawFields {
            guard let field = TranscriptFormFieldSpec(dict: raw) else { continue }
            if fields.contains(where: { $0.name == field.name }) { continue }
            fields.append(field)
        }
        if fields.isEmpty { return nil }
        self.id = (dict["id"] as? String) ?? ""
        self.title = dict["title"] as? String
        self.description = dict["description"] as? String
        let submitLabel = dict["submitLabel"] as? String
        self.submitLabel = (submitLabel?.isEmpty == false) ? submitLabel! : "Submit"
        self.fields = fields
    }

    /// Initial value record, DOM parity: checkbox → false, everything else "".
    func initialValues() -> [String: TranscriptFormValue] {
        var values: [String: TranscriptFormValue] = [:]
        for field in fields {
            values[field.name] = field.type == "checkbox" ? .boolean(false) : .string("")
        }
        return values
    }

    /// Submit payload in field order (JSON.stringify insertion-order parity).
    func orderedValues(from values: [String: TranscriptFormValue]) -> [(name: String, value: TranscriptFormValue)] {
        return fields.map { field in
            (field.name, values[field.name] ?? (field.type == "checkbox" ? .boolean(false) : .string("")))
        }
    }
}

struct TranscriptWorkflowStep: Equatable {
    let label: String
    /// "pending" | "running" | "done" | "failed"
    let status: String
}

struct TranscriptWorkflowData {
    let id: String
    let title: String?
    let steps: [TranscriptWorkflowStep]

    var doneCount: Int { steps.filter { $0.status == "done" }.count }
    var hasFailure: Bool { steps.contains { $0.status == "failed" } }

    init?(widgetData: [String: Any]) {
        guard let workflow = widgetData["workflow"] as? [String: Any],
              let rawSteps = workflow["steps"] as? [[String: Any]] else { return nil }
        var steps: [TranscriptWorkflowStep] = []
        for raw in rawSteps {
            guard let label = raw["label"] as? String else { continue }
            let status = (raw["status"] as? String) ?? "pending"
            steps.append(TranscriptWorkflowStep(label: label, status: status))
        }
        if steps.isEmpty { return nil }
        self.id = (workflow["id"] as? String) ?? ""
        self.title = workflow["title"] as? String
        self.steps = steps
    }
}

struct TranscriptChecklistItem: Equatable {
    let content: String
    /// "pending" | "in_progress" | "completed"
    let status: String
}

struct TranscriptChecklistData {
    let title: String?
    let items: [TranscriptChecklistItem]

    init?(widgetData: [String: Any]) {
        guard let checklist = widgetData["checklist"] as? [String: Any],
              let rawItems = checklist["items"] as? [[String: Any]] else { return nil }
        var items: [TranscriptChecklistItem] = []
        for raw in rawItems {
            guard let content = raw["content"] as? String else { continue }
            let status = (raw["status"] as? String) ?? "pending"
            items.append(TranscriptChecklistItem(content: content, status: status))
        }
        if items.isEmpty { return nil }
        self.title = checklist["title"] as? String
        self.items = items
    }
}

struct TranscriptTaskData {
    let threadId: String
    let title: String
    /// Optional live status label; the marker itself carries none, so the
    /// default pill reads "task".
    let status: String?

    init?(dict: [String: Any]) {
        guard let threadId = dict["threadId"] as? String,
              let title = dict["title"] as? String else { return nil }
        self.threadId = threadId
        self.title = title
        self.status = dict["status"] as? String
    }
}

struct TranscriptPermissionPayload {
    let permission: String
    let reason: String
    let feature: String
    let fallbackOffered: Bool
    let fallbackLabel: String?

    init?(dict: [String: Any]) {
        guard let permission = dict["permission"] as? String,
              let reason = dict["reason"] as? String,
              let feature = dict["feature"] as? String else { return nil }
        self.permission = permission
        self.reason = reason
        self.feature = feature
        self.fallbackOffered = (dict["fallbackOffered"] as? Bool) ?? false
        self.fallbackLabel = dict["fallbackLabel"] as? String
    }

    /// DOM parity: `fallbackLabel ?? (permission == "reminders" ?
    /// "Use internal reminder" : "Use fallback")`.
    var resolvedFallbackLabel: String {
        if let label = fallbackLabel { return label }
        return permission == "reminders" ? "Use internal reminder" : "Use fallback"
    }
}

struct TranscriptSecretRequestData {
    let key: String
    let reason: String?
    let submitLabel: String
    let fieldLabel: String

    init?(dict: [String: Any]) {
        guard let key = dict["key"] as? String, !key.isEmpty else { return nil }
        self.key = key
        self.reason = dict["reason"] as? String
        let form = dict["form"] as? [String: Any]
        let submitLabel = form?["submitLabel"] as? String
        self.submitLabel = (submitLabel?.isEmpty == false) ? submitLabel! : "Submit"
        let firstField = (form?["fields"] as? [[String: Any]])?.first
        self.fieldLabel = (firstField?["label"] as? String) ?? "Secret"
    }
}

/// Friendly card titles per permission id — mirror of `PERMISSION_LABELS` in
/// `permission-card.helpers.ts`; unknown ids fall back to the raw id.
let transcriptPermissionLabels: [String: String] = [
    "accessibility": "Accessibility",
    "screen-recording": "Screen Recording",
    "microphone": "Microphone",
    "camera": "Camera",
    "shell": "Shell",
    "website-blocking": "Website Blocking",
    "location": "Location",
    "reminders": "Apple Reminders",
    "calendar": "Apple Calendar",
    "health": "Apple Health",
    "screentime": "Screen Time",
    "contacts": "Contacts",
    "notes": "Apple Notes",
    "notifications": "Notifications",
    "full-disk": "Full Disk Access",
    "automation": "Automation",
    "speech-recognition": "Speech Recognition",
    "photos": "Photos",
    "phone": "Phone",
    "messages": "Messages",
    "wifi": "Wi-Fi Scans",
    "bluetooth": "Bluetooth",
    "app-blocking": "App Blocking",
    "usage-access": "Usage Access",
    "overlay": "Draw Over Apps",
    "write-settings": "Write Settings",
    "local-network": "Local Network",
    "battery-optimization": "Battery Optimization",
]

func permissionDisplayLabel(_ id: String) -> String {
    return transcriptPermissionLabels[id] ?? id
}

/// The 2x2 background preset grid. Ids come from the shared shader preset
/// catalog (`packages/ui/src/backgrounds/shader-presets.ts`); the first four
/// fill the grid. `[background:set <presetId>]` rides the action channel.
struct TranscriptBackgroundPreset: Equatable {
    let id: String
    let label: String
}

let transcriptBackgroundPresets: [TranscriptBackgroundPreset] = [
    TranscriptBackgroundPreset(id: "aurora", label: "Aurora"),
    TranscriptBackgroundPreset(id: "lava", label: "Lava"),
    TranscriptBackgroundPreset(id: "plasma", label: "Plasma"),
    TranscriptBackgroundPreset(id: "waves", label: "Waves"),
]

// PURE-LOGIC:END

// MARK: - Design tokens (dark glass; orange #ff7a3d is the ONLY accent)

enum TranscriptTheme {
    static let accent = Color(red: 1.0, green: 122.0 / 255.0, blue: 61.0 / 255.0)
    static let textPrimary = Color.white.opacity(0.92)
    static let textSecondary = Color.white.opacity(0.62)
    static let textMuted = Color.white.opacity(0.4)
    static let chipFill = Color.white.opacity(0.08)
    static let chipFillPressed = Color.white.opacity(0.14)
    static let hairline = Color.white.opacity(0.14)
    static let cardFill = Color.white.opacity(0.05)
    static let danger = Color(red: 1.0, green: 0.35, blue: 0.35)
    static let ok = Color(red: 0.42, green: 0.8, blue: 0.55)
}

/// Horizontal wrap for chip rows (iOS 16 `Layout`). Chips take their natural
/// size and flow onto new rows at the proposal width.
struct TranscriptWrapLayout: Layout {
    var spacing: CGFloat = 8

    private func rows(sizes: [CGSize], maxWidth: CGFloat) -> (positions: [CGPoint], size: CGSize) {
        var positions: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var usedWidth: CGFloat = 0
        for size in sizes {
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            positions.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            usedWidth = max(usedWidth, x - spacing)
        }
        return (positions, CGSize(width: usedWidth, height: y + rowHeight))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        return rows(sizes: sizes, maxWidth: proposal.width ?? .infinity).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let sizes = subviews.map { $0.sizeThatFits(.unspecified) }
        let layout = rows(sizes: sizes, maxWidth: bounds.width)
        for (index, subview) in subviews.enumerated() {
            subview.place(
                at: CGPoint(
                    x: bounds.minX + layout.positions[index].x,
                    y: bounds.minY + layout.positions[index].y
                ),
                proposal: .unspecified
            )
        }
    }
}

private struct TranscriptChipStyle: ViewModifier {
    var highlighted: Bool = false
    var faded: Bool = false

    func body(content: Content) -> some View {
        content
            .font(.system(size: 13, weight: .medium))
            .foregroundColor(highlighted ? TranscriptTheme.accent : TranscriptTheme.textPrimary)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(
                Capsule(style: .continuous)
                    .fill(TranscriptTheme.chipFill)
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(
                        highlighted ? TranscriptTheme.accent.opacity(0.7) : TranscriptTheme.hairline,
                        lineWidth: 1
                    )
            )
            .opacity(faded ? 0.4 : 1)
    }
}

private extension View {
    func transcriptChip(highlighted: Bool = false, faded: Bool = false) -> some View {
        modifier(TranscriptChipStyle(highlighted: highlighted, faded: faded))
    }
}

// MARK: - choice

/// `[CHOICE]` — one tap, whole row locks (one decision per prompt). First-run
/// scopes render full-width stacked rows with a chevron (onboarding CTA
/// parity); everything else is a horizontal wrap of chips. Emits the option's
/// raw `value` string.
struct TranscriptChoiceView: View {
    let data: TranscriptChoiceData
    let emit: (String) -> Void

    @State private var selectedValue: String?
    @State private var customMode = false
    @State private var customText = ""

    private var locked: Bool { selectedValue != nil }

    var body: some View {
        Group {
            if data.isFirstRunScope {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(data.options, id: \.value) { option in
                        firstRunRow(option)
                    }
                    customAffordance
                }
            } else {
                TranscriptWrapLayout(spacing: 8) {
                    ForEach(data.options, id: \.value) { option in
                        chip(option)
                    }
                    customAffordance
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func choose(_ value: String) {
        guard !locked else { return }
        selectedValue = value
        emit(choiceActionValue(optionValue: value))
    }

    private func firstRunRow(_ option: TranscriptChoiceOption) -> some View {
        let isSelected = selectedValue == option.value
        return Button(action: { choose(option.value) }) {
            HStack(spacing: 8) {
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(TranscriptTheme.accent)
                }
                Text(option.label)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(TranscriptTheme.textPrimary)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                if !isSelected {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(TranscriptTheme.textMuted)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(TranscriptTheme.chipFill)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(
                        isSelected ? TranscriptTheme.accent.opacity(0.7) : TranscriptTheme.hairline,
                        lineWidth: 1
                    )
            )
            .opacity(locked && !isSelected ? 0.4 : 1)
        }
        .buttonStyle(.plain)
        .disabled(locked)
        .accessibilityLabel(option.label)
    }

    private func chip(_ option: TranscriptChoiceOption) -> some View {
        let isSelected = selectedValue == option.value
        return Button(action: { choose(option.value) }) {
            HStack(spacing: 5) {
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .semibold))
                }
                Text(option.label)
            }
            .transcriptChip(highlighted: isSelected, faded: locked && !isSelected)
        }
        .buttonStyle(.plain)
        .disabled(locked)
        .accessibilityLabel(option.label)
    }

    @ViewBuilder
    private var customAffordance: some View {
        if data.allowCustom && !locked {
            if customMode {
                HStack(spacing: 6) {
                    TextField("Type your answer…", text: $customText)
                        .textFieldStyle(.plain)
                        .font(.system(size: 13))
                        .foregroundColor(TranscriptTheme.textPrimary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(TranscriptTheme.chipFill)
                        )
                        .frame(minWidth: 140)
                    Button("Send") {
                        let value = customText.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !value.isEmpty else { return }
                        choose(value)
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(
                        customText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? TranscriptTheme.textMuted
                            : TranscriptTheme.accent
                    )
                }
            } else {
                Button(action: { customMode = true }) {
                    Text("Other…").transcriptChip()
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - followups

/// `[FOLLOWUPS]` — dismissible suggestion chips. Every kind emits its encoded
/// `payload` string on the one action channel (the JS side routes
/// reply/navigate/prompt); a `reply` locks the row, `navigate` dismisses it.
struct TranscriptFollowupsView: View {
    let data: TranscriptFollowupsData
    let emit: (String) -> Void

    @State private var lockedPayload: String?
    @State private var dismissed = false

    var body: some View {
        if !dismissed {
            TranscriptWrapLayout(spacing: 8) {
                ForEach(Array(data.options.enumerated()), id: \.offset) { _, option in
                    chip(option)
                }
                if lockedPayload == nil {
                    Button(action: { dismissed = true }) {
                        Image(systemName: "xmark")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(TranscriptTheme.textMuted)
                            .padding(7)
                            .background(Circle().fill(TranscriptTheme.chipFill))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss suggestions")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func chip(_ option: TranscriptFollowupOption) -> some View {
        let isChosen = lockedPayload == option.payload
        return Button(action: { act(option) }) {
            HStack(spacing: 5) {
                if isChosen {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .semibold))
                }
                Text(option.label)
                if option.kind == "navigate" && !isChosen {
                    Image(systemName: "arrow.right")
                        .font(.system(size: 11, weight: .semibold))
                }
            }
            .transcriptChip(highlighted: isChosen, faded: lockedPayload != nil && !isChosen)
        }
        .buttonStyle(.plain)
        .disabled(lockedPayload != nil)
        .accessibilityLabel(option.label)
    }

    private func act(_ option: TranscriptFollowupOption) {
        guard lockedPayload == nil else { return }
        emit(option.payload)
        switch option.kind {
        case "navigate":
            dismissed = true
        case "prompt":
            break
        default:
            lockedPayload = option.payload
        }
    }
}

// MARK: - form

/// `[FORM]` — title/description, text fields, menu picker for select, toggle
/// for checkbox, required validation, single submit that locks the form and
/// emits `[form:submit <id>] {json-of-values}`.
struct TranscriptFormView: View {
    let spec: TranscriptFormSpec
    let emit: (String) -> Void

    @State private var values: [String: TranscriptFormValue]
    @State private var errors: [String: String] = [:]
    @State private var submitted = false

    init(spec: TranscriptFormSpec, emit: @escaping (String) -> Void) {
        self.spec = spec
        self.emit = emit
        _values = State(initialValue: spec.initialValues())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title = spec.title {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(TranscriptTheme.textPrimary)
            }
            if let description = spec.description {
                Text(description)
                    .font(.system(size: 12))
                    .foregroundColor(TranscriptTheme.textSecondary)
            }
            ForEach(spec.fields, id: \.name) { field in
                fieldRow(field)
            }
            Button(action: submit) {
                Text(submitted ? "Submitted" : spec.submitLabel)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.black.opacity(0.85))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(
                        Capsule(style: .continuous)
                            .fill(submitted ? TranscriptTheme.accent.opacity(0.45) : TranscriptTheme.accent)
                    )
            }
            .buttonStyle(.plain)
            .disabled(submitted)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(TranscriptTheme.cardFill)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(TranscriptTheme.hairline, lineWidth: 1)
        )
    }

    private func stringBinding(for field: TranscriptFormFieldSpec) -> Binding<String> {
        Binding(
            get: { values[field.name]?.stringValue ?? "" },
            set: { values[field.name] = .string($0) }
        )
    }

    @ViewBuilder
    private func fieldRow(_ field: TranscriptFormFieldSpec) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            if field.type == "checkbox" {
                Toggle(isOn: Binding(
                    get: {
                        if case .boolean(let b) = values[field.name] { return b }
                        return false
                    },
                    set: { values[field.name] = .boolean($0) }
                )) {
                    Text(field.displayLabel)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(TranscriptTheme.textPrimary)
                }
                .tint(TranscriptTheme.accent)
                .disabled(submitted)
            } else if field.type == "select" {
                Text(field.displayLabel)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(TranscriptTheme.textPrimary)
                Menu {
                    ForEach(field.options, id: \.value) { option in
                        Button(option.label) {
                            values[field.name] = .string(option.value)
                            revalidate(field, value: .string(option.value))
                        }
                    }
                } label: {
                    HStack {
                        Text(currentSelectLabel(field))
                            .font(.system(size: 13))
                            .foregroundColor(
                                (values[field.name]?.stringValue ?? "").isEmpty
                                    ? TranscriptTheme.textMuted
                                    : TranscriptTheme.textPrimary
                            )
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(TranscriptTheme.textMuted)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(TranscriptTheme.chipFill)
                    )
                    .overlay(fieldBorder(field))
                }
                .disabled(submitted)
            } else {
                Text(field.displayLabel)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(TranscriptTheme.textPrimary)
                TextField(field.placeholder ?? "", text: stringBinding(for: field))
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .foregroundColor(TranscriptTheme.textPrimary)
                    .keyboardType(field.type == "number" ? .decimalPad : .default)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(TranscriptTheme.chipFill)
                    )
                    .overlay(fieldBorder(field))
                    .disabled(submitted)
                    .onSubmit { revalidate(field, value: values[field.name]) }
            }
            if let error = errors[field.name] {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundColor(TranscriptTheme.danger)
            }
        }
    }

    private func fieldBorder(_ field: TranscriptFormFieldSpec) -> some View {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(
                errors[field.name] != nil ? TranscriptTheme.danger.opacity(0.7) : TranscriptTheme.hairline,
                lineWidth: 1
            )
    }

    private func currentSelectLabel(_ field: TranscriptFormFieldSpec) -> String {
        let current = values[field.name]?.stringValue ?? ""
        if current.isEmpty {
            return field.placeholder ?? "Select…"
        }
        return field.options.first(where: { $0.value == current })?.label ?? current
    }

    private func revalidate(_ field: TranscriptFormFieldSpec, value: TranscriptFormValue?) {
        guard field.required && field.type != "checkbox" else { return }
        if transcriptRequiredSatisfied(value) {
            errors[field.name] = nil
        } else {
            errors[field.name] = requiredErrorMessage(for: field)
        }
    }

    private func submit() {
        guard !submitted else { return }
        let missing = missingRequiredFieldNames(fields: spec.fields, values: values)
        var nextErrors: [String: String] = [:]
        for name in missing {
            if let field = spec.fields.first(where: { $0.name == name }) {
                nextErrors[name] = requiredErrorMessage(for: field)
            }
        }
        errors = nextErrors
        guard nextErrors.isEmpty else { return }
        submitted = true
        emit(formSubmitActionString(formId: spec.id, orderedValues: spec.orderedValues(from: values)))
    }
}

// MARK: - workflow

/// `[WORKFLOW]` — titled step list, done/running/pending/failed glyphs plus a
/// done/total count. Display-only.
struct TranscriptWorkflowView: View {
    let data: TranscriptWorkflowData

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(data.title ?? "Workflow")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(TranscriptTheme.textPrimary)
                Spacer()
                Text("\(data.doneCount)/\(data.steps.count)")
                    .font(.system(size: 11, weight: .medium).monospacedDigit())
                    .foregroundColor(data.hasFailure ? TranscriptTheme.danger : TranscriptTheme.textMuted)
            }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(data.steps.enumerated()), id: \.offset) { index, step in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        stepGlyph(step.status)
                            .frame(width: 16)
                        Text("\(index + 1).")
                            .font(.system(size: 11).monospacedDigit())
                            .foregroundColor(TranscriptTheme.textMuted)
                        Text(step.label)
                            .font(.system(size: 13))
                            .foregroundColor(stepTone(step.status))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func stepGlyph(_ status: String) -> some View {
        switch status {
        case "done":
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 13))
                .foregroundColor(TranscriptTheme.ok)
        case "failed":
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 13))
                .foregroundColor(TranscriptTheme.danger)
        case "running":
            ProgressView()
                .controlSize(.mini)
                .tint(TranscriptTheme.accent)
        default:
            Image(systemName: "circle")
                .font(.system(size: 13))
                .foregroundColor(TranscriptTheme.textMuted)
        }
    }

    private func stepTone(_ status: String) -> Color {
        switch status {
        case "done": return TranscriptTheme.textMuted
        case "failed": return TranscriptTheme.danger
        default: return TranscriptTheme.textPrimary
        }
    }
}

// MARK: - checklist

/// `[CHECKLIST]` — completed items strike through, in-progress carries the
/// accent, pending stays muted. Display-only.
struct TranscriptChecklistView: View {
    let data: TranscriptChecklistData

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(data.title ?? "Checklist")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(TranscriptTheme.textPrimary)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(data.items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        itemGlyph(item.status)
                            .frame(width: 16)
                        Text(item.content)
                            .font(.system(size: 13))
                            .foregroundColor(
                                item.status == "completed"
                                    ? TranscriptTheme.textMuted
                                    : TranscriptTheme.textPrimary
                            )
                            .strikethrough(item.status == "completed", color: TranscriptTheme.textMuted)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func itemGlyph(_ status: String) -> some View {
        switch status {
        case "completed":
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 13))
                .foregroundColor(TranscriptTheme.ok)
        case "in_progress":
            Image(systemName: "circle.lefthalf.filled")
                .font(.system(size: 13))
                .foregroundColor(TranscriptTheme.accent)
        default:
            Image(systemName: "circle")
                .font(.system(size: 13))
                .foregroundColor(TranscriptTheme.textMuted)
        }
    }
}

// MARK: - task

/// `[TASK:<threadId>]` — coding-task card: title plus a status pill. The
/// marker carries no live status, so the pill defaults to "task"; a serializer
/// that adds `status` later shows it unchanged.
struct TranscriptTaskView: View {
    let data: TranscriptTaskData

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "hammer")
                .font(.system(size: 13))
                .foregroundColor(TranscriptTheme.textSecondary)
            Text(data.title)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(TranscriptTheme.textPrimary)
                .lineLimit(2)
            Spacer(minLength: 8)
            Text((data.status ?? "task").replacingOccurrences(of: "_", with: " "))
                .font(.system(size: 10, weight: .semibold))
                .textCase(.uppercase)
                .foregroundColor(TranscriptTheme.textSecondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Capsule(style: .continuous).fill(TranscriptTheme.chipFill))
                .overlay(Capsule(style: .continuous).strokeBorder(TranscriptTheme.hairline, lineWidth: 1))
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(TranscriptTheme.cardFill)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(TranscriptTheme.hairline, lineWidth: 1)
        )
        .accessibilityLabel("Task: \(data.title)")
    }
}

// MARK: - background

/// `[BACKGROUND]` — 2x2 shader-preset swatch grid; a tap emits
/// `[background:set <presetId>]` and marks the swatch selected. Swatch
/// gradients approximate each shader's hue (no blue; orange stays accent).
struct TranscriptBackgroundView: View {
    let emit: (String) -> Void

    @State private var selectedPresetId: String?

    private static let swatchGradients: [String: [Color]] = [
        "aurora": [Color(red: 0.05, green: 0.22, blue: 0.16), Color(red: 0.16, green: 0.5, blue: 0.34)],
        "lava": [Color(red: 0.25, green: 0.06, blue: 0.02), Color(red: 0.85, green: 0.3, blue: 0.08)],
        "plasma": [Color(red: 0.2, green: 0.05, blue: 0.18), Color(red: 0.65, green: 0.2, blue: 0.5)],
        "waves": [Color(red: 0.09, green: 0.09, blue: 0.11), Color(red: 0.32, green: 0.33, blue: 0.36)],
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Background")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(TranscriptTheme.textPrimary)
            LazyVGrid(
                columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)],
                spacing: 8
            ) {
                ForEach(transcriptBackgroundPresets, id: \.id) { preset in
                    swatch(preset)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func swatch(_ preset: TranscriptBackgroundPreset) -> some View {
        let isSelected = selectedPresetId == preset.id
        let colors = Self.swatchGradients[preset.id] ?? [Color.black, Color.gray]
        return Button(action: {
            selectedPresetId = preset.id
            emit(backgroundSetActionString(presetId: preset.id))
        }) {
            ZStack(alignment: .bottomLeading) {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: colors,
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(height: 64)
                Text(preset.label)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.white.opacity(0.9))
                    .padding(8)
                if isSelected {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(TranscriptTheme.accent, lineWidth: 2)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Set background: \(preset.label)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

// MARK: - permission (segment kind "permission", not a widgetKind)

/// Permission payload card: friendly permission title, the agent's reason,
/// "Use fallback" (emits the `__permission_card__:use_fallback …` string) and
/// "Not now" (local dismiss). Grant/check flows stay DOM/JS-owned — this card
/// only signals the fallback decision, exactly like the DOM `onFallback` path.
struct TranscriptPermissionCardView: View {
    let payload: TranscriptPermissionPayload
    let emit: (String) -> Void

    @State private var dismissed = false

    var body: some View {
        if !dismissed {
            VStack(alignment: .leading, spacing: 8) {
                Text(permissionDisplayLabel(payload.permission))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(TranscriptTheme.textPrimary)
                Text(payload.reason)
                    .font(.system(size: 13))
                    .foregroundColor(TranscriptTheme.textSecondary)
                HStack(spacing: 10) {
                    if payload.fallbackOffered {
                        Button(action: {
                            emit(permissionFallbackActionString(
                                feature: payload.feature,
                                permission: payload.permission
                            ))
                            dismissed = true
                        }) {
                            Text(payload.resolvedFallbackLabel).transcriptChip()
                        }
                        .buttonStyle(.plain)
                    }
                    Spacer()
                    Button(action: { dismissed = true }) {
                        Text("Not now")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(TranscriptTheme.textMuted)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(TranscriptTheme.cardFill)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(TranscriptTheme.hairline, lineWidth: 1)
            )
            .accessibilityLabel("Permission request: \(permissionDisplayLabel(payload.permission))")
        }
    }
}

// MARK: - secretRequest (message side-channel)

/// Pending secret/OAuth request: reason, masked SecureField, submit. Submit
/// emits only the `[secret:submit <key>]` SIGNAL — the typed value never rides
/// the action channel; the JS side owns the real secure submission.
struct TranscriptSecretRequestView: View {
    let data: TranscriptSecretRequestData
    let emit: (String) -> Void

    @State private var secretValue = ""
    @State private var submitted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 12))
                    .foregroundColor(TranscriptTheme.accent)
                Text(data.fieldLabel)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(TranscriptTheme.textPrimary)
            }
            if let reason = data.reason {
                Text(reason)
                    .font(.system(size: 12))
                    .foregroundColor(TranscriptTheme.textSecondary)
            }
            SecureField("••••••••", text: $secretValue)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .foregroundColor(TranscriptTheme.textPrimary)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(TranscriptTheme.chipFill)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(TranscriptTheme.hairline, lineWidth: 1)
                )
                .disabled(submitted)
            Button(action: {
                guard !submitted && !secretValue.isEmpty else { return }
                submitted = true
                emit(secretSubmitActionString(key: data.key))
            }) {
                Text(submitted ? "Submitted" : data.submitLabel)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.black.opacity(0.85))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(
                        Capsule(style: .continuous)
                            .fill(
                                submitted || secretValue.isEmpty
                                    ? TranscriptTheme.accent.opacity(0.45)
                                    : TranscriptTheme.accent
                            )
                    )
            }
            .buttonStyle(.plain)
            .disabled(submitted || secretValue.isEmpty)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(TranscriptTheme.cardFill)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(TranscriptTheme.hairline, lineWidth: 1)
        )
    }
}

// MARK: - ui-spec / config fallbacks

/// `ui-spec` segments carry agent-generated UI the native renderer does not
/// re-implement; render a labeled placeholder so the turn stays legible.
struct TranscriptUiSpecFallbackView: View {
    let raw: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkles")
                .font(.system(size: 12))
                .foregroundColor(TranscriptTheme.accent)
            Text("Generated UI — open in the app view")
                .font(.system(size: 12))
                .foregroundColor(TranscriptTheme.textSecondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(TranscriptTheme.cardFill)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(TranscriptTheme.hairline, lineWidth: 1)
        )
        .accessibilityLabel("Generated UI")
    }
}

/// `config` segments open a plugin's configuration surface on the DOM side;
/// natively they render as a labeled reference card.
struct TranscriptConfigFallbackView: View {
    let pluginId: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "gearshape")
                .font(.system(size: 12))
                .foregroundColor(TranscriptTheme.textSecondary)
            Text("Plugin configuration — \(pluginId)")
                .font(.system(size: 12))
                .foregroundColor(TranscriptTheme.textSecondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(TranscriptTheme.cardFill)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(TranscriptTheme.hairline, lineWidth: 1)
        )
        .accessibilityLabel("Plugin configuration: \(pluginId)")
    }
}

/// Undecodable widget data degrades to a visible marker (three-state rule:
/// never render healthy-empty from a decode failure).
struct TranscriptMalformedWidgetView: View {
    let kind: String

    var body: some View {
        Text("Unavailable widget (\(kind))")
            .font(.system(size: 12))
            .foregroundColor(TranscriptTheme.textMuted)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(TranscriptTheme.cardFill)
            )
    }
}

// MARK: - Registration seam

/// Builder signature the registry consumes: raw widget `data` dictionary from
/// the decoded frame plus the single action-emit closure, returning the
/// type-erased widget view.
typealias TranscriptWidgetBuilder = (
    _ widgetData: [String: Any],
    _ emit: @escaping (String) -> Void
) -> AnyView

/// Every builtin widgetKind → builder. Exposed as a plain dictionary so the
/// ios-core lane's `WidgetRegistry` can consume it regardless of its exact
/// registration API shape.
func transcriptBuiltinWidgetBuilders() -> [String: TranscriptWidgetBuilder] {
    return [
        "choice": { data, emit in
            guard let choice = TranscriptChoiceData(dict: data) else {
                return AnyView(TranscriptMalformedWidgetView(kind: "choice"))
            }
            return AnyView(TranscriptChoiceView(data: choice, emit: emit))
        },
        "followups": { data, emit in
            guard let followups = TranscriptFollowupsData(dict: data) else {
                return AnyView(TranscriptMalformedWidgetView(kind: "followups"))
            }
            return AnyView(TranscriptFollowupsView(data: followups, emit: emit))
        },
        "form": { data, emit in
            guard let spec = TranscriptFormSpec(widgetData: data) else {
                return AnyView(TranscriptMalformedWidgetView(kind: "form"))
            }
            return AnyView(TranscriptFormView(spec: spec, emit: emit))
        },
        "workflow": { data, _ in
            guard let workflow = TranscriptWorkflowData(widgetData: data) else {
                return AnyView(TranscriptMalformedWidgetView(kind: "workflow"))
            }
            return AnyView(TranscriptWorkflowView(data: workflow))
        },
        "checklist": { data, _ in
            guard let checklist = TranscriptChecklistData(widgetData: data) else {
                return AnyView(TranscriptMalformedWidgetView(kind: "checklist"))
            }
            return AnyView(TranscriptChecklistView(data: checklist))
        },
        "task": { data, _ in
            guard let task = TranscriptTaskData(dict: data) else {
                return AnyView(TranscriptMalformedWidgetView(kind: "task"))
            }
            return AnyView(TranscriptTaskView(data: task))
        },
        "background": { _, emit in
            AnyView(TranscriptBackgroundView(emit: emit))
        },
    ]
}

/// The seam the ios-core lane calls once at plugin setup. `WidgetRegistry`
/// (owned by ios-core's WidgetRegistry.swift) is expected to expose
/// `static func register(_ kind: String, _ build: @escaping TranscriptWidgetBuilder)`;
/// if core chose a different shape, adapt this loop — the builders dictionary
/// above is the stable surface.
extension WidgetRegistry {
    static func registerBuiltins() {
        for (kind, build) in transcriptBuiltinWidgetBuilders() {
            register(kind, build)
        }
    }
}
