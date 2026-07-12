#!/usr/bin/env swift
// Logic-check harness for TranscriptWidgets.swift — NOT part of the Xcode
// build target. Extracts the PURE-LOGIC region from the sibling
// TranscriptWidgets.swift verbatim (so the code under test IS the shipped
// code), appends the assertions below, and runs the combined script against
// the committed golden fixture
// (packages/ui/src/chat/native-transcript/__fixtures__/transcript-golden.json).
// Run: ./TranscriptWidgets.test.swift   (or: swift TranscriptWidgets.test.swift)
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

let scriptURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
let dirURL = scriptURL.deletingLastPathComponent()
let sourceURL = dirURL.appendingPathComponent("TranscriptWidgets.swift")
guard let source = try? String(contentsOf: sourceURL, encoding: .utf8) else {
    fail("cannot read \(sourceURL.path)")
}
// Line-start anchored so prose mentions of the markers can never match.
guard let begin = source.range(of: "\n// PURE-LOGIC:BEGIN"),
      let end = source.range(of: "\n// PURE-LOGIC:END"),
      begin.upperBound < end.lowerBound else {
    fail("PURE-LOGIC markers missing in TranscriptWidgets.swift")
}
let pureLogic = String(source[begin.upperBound..<end.lowerBound])

// Walk up to the repo root to find the golden fixture (script lives 7 levels
// below the repo root in both iOS trees).
var cursor = dirURL
var fixtureURL: URL?
for _ in 0..<14 {
    let candidate = cursor.appendingPathComponent(
        "packages/ui/src/chat/native-transcript/__fixtures__/transcript-golden.json")
    if FileManager.default.fileExists(atPath: candidate.path) {
        fixtureURL = candidate
        break
    }
    let parent = cursor.deletingLastPathComponent()
    if parent.path == cursor.path { break }
    cursor = parent
}
guard let fixture = fixtureURL else {
    fail("transcript-golden.json not found above \(dirURL.path)")
}

let tests = #"""

// ---- logic-check assertions (appended by TranscriptWidgets.test.swift) ----

var failures = 0
var total = 0
func check(_ cond: Bool, _ name: String) {
    total += 1
    if cond { print("PASS  \(name)") } else { failures += 1; print("FAIL  \(name)") }
}

let fixturePath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
guard let fixtureData = FileManager.default.contents(atPath: fixturePath),
      let fixtureRoot = (try? JSONSerialization.jsonObject(with: fixtureData)) as? [String: Any],
      let messages = fixtureRoot["messages"] as? [[String: Any]] else {
    print("FAIL  cannot load golden fixture at \(fixturePath)")
    exit(1)
}
check(fixtureRoot["schema"] as? String == "eliza.native-transcript/v1", "fixture schema is v1")

var seen: [String: Int] = [:]
var decoded: [String: Int] = [:]
var goldenChoice: TranscriptChoiceData?
var goldenFollowups: TranscriptFollowupsData?
var goldenForm: TranscriptFormSpec?
var goldenWorkflow: TranscriptWorkflowData?
var goldenChecklist: TranscriptChecklistData?
var goldenTask: TranscriptTaskData?
var goldenPermission: TranscriptPermissionPayload?
var goldenSecret: TranscriptSecretRequestData?
var uiSpecSeen = false
var configSeen = false

for message in messages {
    if let secret = message["secretRequest"] as? [String: Any] {
        goldenSecret = TranscriptSecretRequestData(dict: secret)
    }
    guard let segments = message["segments"] as? [[String: Any]] else { continue }
    for segment in segments {
        let kind = segment["kind"] as? String ?? ""
        if kind == "permission", let payload = segment["payload"] as? [String: Any] {
            goldenPermission = TranscriptPermissionPayload(dict: payload)
            continue
        }
        if kind == "ui-spec" { uiSpecSeen = (segment["raw"] as? String)?.isEmpty == false; continue }
        if kind == "config" { configSeen = (segment["pluginId"] as? String) != nil; continue }
        guard kind == "widget", let widgetKind = segment["widgetKind"] as? String else { continue }
        let data = segment["data"] as? [String: Any] ?? [:]
        seen[widgetKind, default: 0] += 1
        switch widgetKind {
        case "choice":
            if let d = TranscriptChoiceData(dict: data) {
                decoded[widgetKind, default: 0] += 1
                if goldenChoice == nil { goldenChoice = d }
            }
        case "followups":
            if let d = TranscriptFollowupsData(dict: data) {
                decoded[widgetKind, default: 0] += 1
                goldenFollowups = d
            }
        case "form":
            if let d = TranscriptFormSpec(widgetData: data) {
                decoded[widgetKind, default: 0] += 1
                goldenForm = d
            }
        case "workflow":
            if let d = TranscriptWorkflowData(widgetData: data) {
                decoded[widgetKind, default: 0] += 1
                goldenWorkflow = d
            }
        case "checklist":
            if let d = TranscriptChecklistData(widgetData: data) {
                decoded[widgetKind, default: 0] += 1
                goldenChecklist = d
            }
        case "task":
            if let d = TranscriptTaskData(dict: data) {
                decoded[widgetKind, default: 0] += 1
                goldenTask = d
            }
        case "background":
            decoded[widgetKind, default: 0] += 1
        default:
            break
        }
    }
}

for kind in ["choice", "followups", "form", "workflow", "checklist", "task", "background"] {
    check((seen[kind] ?? 0) >= 1, "golden fixture contains \(kind)")
    check(seen[kind] == decoded[kind], "every golden \(kind) decodes (\(decoded[kind] ?? 0)/\(seen[kind] ?? 0))")
}
check(uiSpecSeen, "golden fixture ui-spec raw present")

// choice — value passthrough
check(goldenChoice?.id == "runtime" && goldenChoice?.scope == "first-run", "choice id/scope decode")
check(goldenChoice?.isFirstRunScope == true, "choice first-run scope detected")
check(goldenChoice?.options.first?.value == "__first_run__:runtime:cloud", "choice option value decode")
check(goldenChoice?.options.first?.label == "Sign in to Eliza Cloud", "choice option label decode")
check(goldenChoice?.allowCustom == false, "choice allowCustom decode")
check(choiceActionValue(optionValue: "__first_run__:runtime:cloud") == "__first_run__:runtime:cloud",
      "choice tap emits the option VALUE unchanged")

// followups — encoded payload passthrough
check(goldenFollowups?.options.map { $0.payload } == ["Show me widgets", "Refine the plan for", "/settings"],
      "followups payloads decode in order")
check(goldenFollowups?.options.map { $0.kind } == ["reply", "prompt", "navigate"], "followups kinds decode")

// form — decode
check(goldenForm?.id == "onboarding-profile", "form id decode")
check(goldenForm?.title == "Set up your assistant", "form title decode")
check(goldenForm?.submitLabel == "Save profile", "form submitLabel decode")
check(goldenForm?.fields.map { $0.name } == ["name", "focus", "daily"], "form field order preserved")
check(goldenForm?.fields.map { $0.type } == ["text", "select", "checkbox"], "form field types decode")
check(goldenForm?.fields[1].options.map { $0.value } == ["work", "personal", "both"], "select options decode")
check(goldenForm?.fields[0].required == true, "form required flag decode")

// form — validation (parity with DOM runValidation "required": v != null && v !== "")
if let form = goldenForm {
    let initial = form.initialValues()
    check(missingRequiredFieldNames(fields: form.fields, values: initial) == ["name"],
          "required-empty blocks submit (name missing)")
    var filled = initial
    filled["name"] = .string("Shaw")
    check(missingRequiredFieldNames(fields: form.fields, values: filled).isEmpty,
          "filled required field unblocks submit")
    var spacey = initial
    spacey["name"] = .string(" ")
    check(missingRequiredFieldNames(fields: form.fields, values: spacey).isEmpty,
          "whitespace passes required (DOM v !== \"\" parity)")
    check(requiredErrorMessage(for: form.fields[0]) == "What should I call you? is required",
          "required error message uses field label")

    filled["focus"] = .string("work")
    let action = formSubmitActionString(formId: form.id, orderedValues: form.orderedValues(from: filled))
    check(action == "[form:submit onboarding-profile] {\"name\":\"Shaw\",\"focus\":\"work\",\"daily\":false}",
          "form submit action string exact (field-order JSON)")
} else {
    check(false, "golden form decoded")
}

// required checkbox is never required-validated (DOM parity)
if let requiredCheckbox = TranscriptFormFieldSpec(dict: ["name": "agree", "type": "checkbox", "required": true]) {
    check(missingRequiredFieldNames(fields: [requiredCheckbox], values: [:]).isEmpty,
          "required checkbox never blocks submit")
} else {
    check(false, "checkbox field decodes")
}

// JSON escaping — JSON.stringify parity
check(transcriptJsonEscaped("a\"b\\c\nd\te") == "a\\\"b\\\\c\\nd\\te", "jsonEscaped matches JSON.stringify")
check(transcriptJsonEscaped("\u{01}") == "\\u0001", "jsonEscaped control chars as \\u00XX")
check(TranscriptFormValue.boolean(true).jsonFragment == "true", "boolean value serializes bare")
check(TranscriptFormValue.string("x/y").jsonFragment == "\"x/y\"", "slash is not escaped (stringify parity)")

// workflow — decode
check(goldenWorkflow?.title == "Ship mobile polish", "workflow title decode")
check(goldenWorkflow?.steps.map { $0.status } == ["done", "running", "pending"], "workflow step statuses decode")
check(goldenWorkflow?.steps.map { $0.label } == ["Capture iOS", "Tune glass", "Verify Android"], "workflow step labels decode")
check(goldenWorkflow?.doneCount == 1 && goldenWorkflow?.hasFailure == false, "workflow done count / failure flag")

// checklist — decode
check(goldenChecklist?.title == "UX review", "checklist title decode")
check(goldenChecklist?.items.map { $0.status } == ["completed", "in_progress", "pending"], "checklist item statuses decode")
check(goldenChecklist?.items.first?.content == "Tap every control", "checklist item content decode")

// task — decode
check(goldenTask?.threadId == "00000000-0000-4000-8000-000000000001", "task threadId decode")
check(goldenTask?.title == "Refine native chat glass", "task title decode")
check(goldenTask?.status == nil, "task status absent in marker data")

// background — action string + preset grid
check(backgroundSetActionString(presetId: "aurora") == "[background:set aurora]", "background action string exact")
check(transcriptBackgroundPresets.map { $0.id } == ["aurora", "lava", "plasma", "waves"], "2x2 preset grid ids")

// permission — decode + action string + labels
check(goldenPermission?.permission == "reminders" && goldenPermission?.feature == "onboarding.reminders",
      "permission payload decode")
check(goldenPermission?.fallbackOffered == true, "permission fallbackOffered decode")
check(goldenPermission?.resolvedFallbackLabel == "Use internal reminder", "reminders fallback label parity")
check(permissionFallbackActionString(feature: "onboarding.reminders", permission: "reminders")
      == "__permission_card__:use_fallback feature=onboarding.reminders permission=reminders",
      "permission fallback action string exact")
check(permissionDisplayLabel("reminders") == "Apple Reminders", "permission display label map")
check(permissionDisplayLabel("unknown-thing") == "unknown-thing", "unknown permission falls back to raw id")

// secretRequest — decode + signal string
check(goldenSecret?.key == "HARNESS_API_KEY", "secretRequest key decode")
check(goldenSecret?.submitLabel == "Save key", "secretRequest submitLabel decode")
check(goldenSecret?.fieldLabel == "API key", "secretRequest field label decode")
check(secretSubmitActionString(key: "HARNESS_API_KEY") == "[secret:submit HARNESS_API_KEY]",
      "secret submit action string exact")

// malformed data degrades to nil (renders the visible malformed marker, never healthy-empty)
check(TranscriptChoiceData(dict: [:]) == nil, "empty choice data is rejected")
check(TranscriptFormSpec(widgetData: ["form": ["fields": []]]) == nil, "fieldless form is rejected")
check(TranscriptWorkflowData(widgetData: [:]) == nil, "workflow without steps is rejected")
check(TranscriptTaskData(dict: ["title": "x"]) == nil, "task without threadId is rejected")

_ = configSeen // fixture currently carries no config segment; decoder path is exercised above

print(failures == 0 ? "ALL \(total) CHECKS PASSED" : "\(failures)/\(total) CHECKS FAILED")
exit(failures == 0 ? 0 : 1)
"""#

let combined = "import Foundation\n" + pureLogic + "\n" + tests + "\n"
let tempDir = FileManager.default.temporaryDirectory
    .appendingPathComponent("transcript-widgets-logic-\(ProcessInfo.processInfo.processIdentifier)")
do {
    try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    let combinedURL = tempDir.appendingPathComponent("transcript-widgets-pure-logic.swift")
    try combined.write(to: combinedURL, atomically: true, encoding: .utf8)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["swift", combinedURL.path, fixture.path]
    try process.run()
    process.waitUntilExit()
    exit(process.terminationStatus)
} catch {
    fail("logic-check runner failed: \(error)")
}
