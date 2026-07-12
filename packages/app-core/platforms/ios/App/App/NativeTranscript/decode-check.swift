#!/usr/bin/env swift
// swift-script guard: standalone conformance check — NOT an app-target
// source. Never add this file to the Xcode Sources build phase. Run it
// directly against the committed golden fixture:
//
//   swift decode-check.swift \
//     packages/ui/src/chat/native-transcript/__fixtures__/transcript-golden.json
//
// Exit 0 = the fixture decoded with zero unknown segments and every expected
// segment kind, widget kind, and message side-channel present. Any other
// exit means the Swift models drifted from spec.ts.
//
// Self-contained on purpose: `swift <file>` has no module system, so the
// Codable core of TranscriptModels.swift is duplicated inline (views and
// convenience accessors omitted). When the models change, update BOTH files —
// this script is the gate that catches drift against the golden fixture.

import Foundation

// MARK: - Models (duplicated from TranscriptModels.swift — keep in lockstep)

enum TranscriptJSONValue: Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([TranscriptJSONValue])
    case object([String: TranscriptJSONValue])
}

extension TranscriptJSONValue: Codable {
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let array = try? container.decode([TranscriptJSONValue].self) {
            self = .array(array)
        } else if let object = try? container.decode([String: TranscriptJSONValue].self) {
            self = .object(object)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "value is not JSON")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

enum TranscriptRole: String, Codable {
    case user
    case assistant

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TranscriptRole(rawValue: raw) ?? .assistant
    }
}

enum TranscriptSegment: Equatable {
    case text(String)
    case code(code: String, lang: String?, inline: Bool)
    case widget(widgetKind: String, data: TranscriptJSONValue)
    case permission(payload: TranscriptJSONValue)
    case uiSpec(raw: String)
    case config(pluginId: String)
    case unknown(kind: String)
}

extension TranscriptSegment: Codable {
    private enum CodingKeys: String, CodingKey {
        case kind, text, code, lang, inline, widgetKind, data, payload, raw, pluginId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = (try? container.decode(String.self, forKey: .kind)) ?? ""
        switch kind {
        case "text":
            if let text = try? container.decode(String.self, forKey: .text) {
                self = .text(text)
                return
            }
        case "code":
            if let code = try? container.decode(String.self, forKey: .code) {
                let lang = (try? container.decodeIfPresent(String.self, forKey: .lang)) ?? nil
                let inline = ((try? container.decodeIfPresent(Bool.self, forKey: .inline)) ?? nil) ?? false
                self = .code(code: code, lang: lang, inline: inline)
                return
            }
        case "widget":
            if let widgetKind = try? container.decode(String.self, forKey: .widgetKind) {
                let data =
                    ((try? container.decodeIfPresent(TranscriptJSONValue.self, forKey: .data))
                        ?? nil) ?? .null
                self = .widget(widgetKind: widgetKind, data: data)
                return
            }
        case "permission":
            let payload =
                ((try? container.decodeIfPresent(TranscriptJSONValue.self, forKey: .payload))
                    ?? nil) ?? .null
            self = .permission(payload: payload)
            return
        case "ui-spec":
            if let raw = try? container.decode(String.self, forKey: .raw) {
                self = .uiSpec(raw: raw)
                return
            }
        case "config":
            if let pluginId = try? container.decode(String.self, forKey: .pluginId) {
                self = .config(pluginId: pluginId)
                return
            }
        default:
            break
        }
        self = .unknown(kind: kind)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let text):
            try container.encode("text", forKey: .kind)
            try container.encode(text, forKey: .text)
        case .code(let code, let lang, let inline):
            try container.encode("code", forKey: .kind)
            try container.encode(code, forKey: .code)
            try container.encodeIfPresent(lang, forKey: .lang)
            try container.encode(inline, forKey: .inline)
        case .widget(let widgetKind, let data):
            try container.encode("widget", forKey: .kind)
            try container.encode(widgetKind, forKey: .widgetKind)
            try container.encode(data, forKey: .data)
        case .permission(let payload):
            try container.encode("permission", forKey: .kind)
            try container.encode(payload, forKey: .payload)
        case .uiSpec(let raw):
            try container.encode("ui-spec", forKey: .kind)
            try container.encode(raw, forKey: .raw)
        case .config(let pluginId):
            try container.encode("config", forKey: .kind)
            try container.encode(pluginId, forKey: .pluginId)
        case .unknown(let kind):
            try container.encode(kind, forKey: .kind)
        }
    }

    var kindName: String {
        switch self {
        case .text: return "text"
        case .code: return "code"
        case .widget: return "widget"
        case .permission: return "permission"
        case .uiSpec: return "ui-spec"
        case .config: return "config"
        case .unknown(let kind): return "unknown(\(kind))"
        }
    }
}

struct TranscriptToolEvent: Codable, Equatable {
    var id: String?
    var type: String?
    var callId: String?
    var toolCallId: String?
    var actionName: String?
    var toolName: String?
    var name: String?
    var args: TranscriptJSONValue?
    var input: TranscriptJSONValue?
    var result: TranscriptJSONValue?
    var output: TranscriptJSONValue?
    var status: String?
    var success: Bool?
    var durationMs: Double?
    var duration: Double?
    var error: String?
    var stage: String?
}

struct TranscriptSecretField: Codable, Equatable {
    var name: String?
    var label: String?
    var input: String?
    var required: Bool?
}

struct TranscriptSecretForm: Codable, Equatable {
    var kind: String?
    var submitLabel: String?
    var statusOnly: Bool?
    var provider: String?
    var fields: [TranscriptSecretField]?
}

struct TranscriptSecretRequest: Codable, Equatable {
    var key: String?
    var reason: String?
    var status: String?
    var form: TranscriptSecretForm?
}

struct TranscriptTurnStatus: Codable, Equatable {
    var kind: String
    var label: String?
}

struct TranscriptMessage: Codable, Equatable {
    var id: String
    var role: TranscriptRole
    var segments: [TranscriptSegment]
    var reasoning: String?
    var toolEvents: [TranscriptToolEvent]?
    var failureKind: String?
    var secretRequest: TranscriptSecretRequest?
    var streaming: Bool?
}

struct TranscriptFrame: Codable, Equatable {
    static let supportedSchema = "eliza.native-transcript/v1"

    var schema: String
    var messages: [TranscriptMessage]
    var turnStatus: TranscriptTurnStatus?
}

// MARK: - Conformance check

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("decode-check: \(message)\n".utf8))
    exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    FileHandle.standardError.write(
        Data("usage: swift decode-check.swift <transcript-golden.json>\n".utf8))
    exit(2)
}

let fixtureURL = URL(fileURLWithPath: arguments[1])
let fixtureData: Data
do {
    fixtureData = try Data(contentsOf: fixtureURL)
} catch {
    fail("cannot read \(fixtureURL.path): \(error)")
}

let frame: TranscriptFrame
do {
    frame = try JSONDecoder().decode(TranscriptFrame.self, from: fixtureData)
} catch {
    fail("frame failed to decode: \(error)")
}

guard frame.schema == TranscriptFrame.supportedSchema else {
    fail("schema mismatch: \(frame.schema) != \(TranscriptFrame.supportedSchema)")
}

var segmentKinds: [String: Int] = [:]
var widgetKinds: [String: Int] = [:]
var unknownKinds: [String] = []
var sideChannels: [String: Int] = [:]

for message in frame.messages {
    for segment in message.segments {
        segmentKinds[segment.kindName, default: 0] += 1
        if case .widget(let widgetKind, _) = segment {
            widgetKinds[widgetKind, default: 0] += 1
        }
        if case .unknown(let kind) = segment {
            unknownKinds.append(kind)
        }
    }
    if message.reasoning != nil { sideChannels["reasoning", default: 0] += 1 }
    if let toolEvents = message.toolEvents, !toolEvents.isEmpty {
        sideChannels["toolEvents", default: 0] += 1
    }
    if message.failureKind != nil { sideChannels["failureKind", default: 0] += 1 }
    if message.secretRequest != nil { sideChannels["secretRequest", default: 0] += 1 }
    if message.streaming == true { sideChannels["streaming", default: 0] += 1 }
}

print("schema: \(frame.schema)")
print("messages: \(frame.messages.count)")
print("segment kinds:")
for (kind, count) in segmentKinds.sorted(by: { $0.key < $1.key }) {
    print("  \(kind): \(count)")
}
print("widget kinds:")
for (kind, count) in widgetKinds.sorted(by: { $0.key < $1.key }) {
    print("  \(kind): \(count)")
}
print("side channels:")
for (channel, count) in sideChannels.sorted(by: { $0.key < $1.key }) {
    print("  \(channel): \(count)")
}

guard unknownKinds.isEmpty else {
    fail("golden fixture decoded \(unknownKinds.count) unknown segment(s): \(unknownKinds)")
}

// The golden fixture exercises every kind the DOM harness can produce; a
// missing entry here means either the fixture regressed or the models did.
let requiredSegmentKinds = ["text", "code", "widget", "permission", "ui-spec"]
let requiredWidgetKinds = [
    "choice", "followups", "form", "workflow", "checklist", "task", "background",
]
let requiredSideChannels = ["reasoning", "toolEvents", "failureKind", "secretRequest"]

let missingSegments = requiredSegmentKinds.filter { segmentKinds[$0] == nil }
let missingWidgets = requiredWidgetKinds.filter { widgetKinds[$0] == nil }
let missingSides = requiredSideChannels.filter { sideChannels[$0] == nil }

guard missingSegments.isEmpty, missingWidgets.isEmpty, missingSides.isEmpty else {
    fail(
        "missing coverage — segments: \(missingSegments), widgets: \(missingWidgets), side channels: \(missingSides)"
    )
}

print("OK — all required segment kinds, widget kinds, and side channels decoded")
