import Foundation

/// Codable models for the native-transcript v1 frame — the JSON projection of
/// a chat transcript that the webview hands to the native renderer through the
/// `NativeTranscript` Capacitor plugin. TS source of truth:
/// `packages/ui/src/chat/native-transcript/spec.ts`; conformance is proven
/// against the committed golden fixture
/// (`packages/ui/src/chat/native-transcript/__fixtures__/transcript-golden.json`)
/// by the standalone `decode-check.swift` script in this directory, which
/// duplicates this file's Codable core — keep the two in lockstep.
///
/// Decode tolerance is deliberate and asymmetric: the v1 contract is additive,
/// so a NEWER serializer may ship segment kinds this build has never seen.
/// An unknown or structurally short segment decodes as the explicit
/// `.unknown` fallback (renderers skip it — DOM parity: the parser returns
/// null), never a thrown error that would reject the whole frame. Everything
/// message-level beyond `id`/`role`/`segments` is optional side-channel data.

// MARK: - JSON value

/// Arbitrary JSON payloads (widget data, permission payloads, tool args and
/// results) that native code re-interprets per widget kind. Widget bodies read
/// through the typed accessors instead of re-decoding raw JSON.
enum TranscriptJSONValue: Equatable, Sendable {
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

extension TranscriptJSONValue {
    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var arrayValue: [TranscriptJSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    var objectValue: [String: TranscriptJSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    subscript(key: String) -> TranscriptJSONValue? {
        objectValue?[key]
    }

    subscript(index: Int) -> TranscriptJSONValue? {
        guard let array = arrayValue, array.indices.contains(index) else { return nil }
        return array[index]
    }

    /// Stable JSON rendering for diagnostic surfaces (tool args/results rows).
    /// Encoding a value composed only of JSON cases cannot fail; the empty
    /// string return exists to satisfy the compiler, not as a data fallback.
    func jsonString(pretty: Bool = false) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = pretty ? [.sortedKeys, .prettyPrinted] : [.sortedKeys]
        guard let data = try? encoder.encode(self) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
}

// MARK: - Role

/// `user` | `assistant`. A role this build does not know renders with the
/// assistant layout (full-width left) — the safe reading for any future
/// system-ish role, and it keeps the frame decodable.
enum TranscriptRole: String, Codable, Sendable {
    case user
    case assistant

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TranscriptRole(rawValue: raw) ?? .assistant
    }
}

// MARK: - Segments

/// Mirrors `NativeSegment` in spec.ts 1:1, plus the `.unknown` fallback.
enum TranscriptSegment: Equatable, Sendable {
    case text(String)
    case code(code: String, lang: String?, inline: Bool)
    case widget(widgetKind: String, data: TranscriptJSONValue)
    case permission(payload: TranscriptJSONValue)
    case uiSpec(raw: String)
    case config(pluginId: String)
    /// Kinds this build does not know (newer serializer within v1). Renderers
    /// skip it — DOM parity: the parser maps unknown kinds to null.
    case unknown(kind: String)
}

extension TranscriptSegment: Codable {
    private enum CodingKeys: String, CodingKey {
        case kind, text, code, lang, inline, widgetKind, data, payload, raw, pluginId
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = (try? container.decode(String.self, forKey: .kind)) ?? ""
        // error-policy:J3 untrusted webview boundary — an unknown kind or a
        // known kind missing its required field decodes as the explicit
        // `.unknown` fallback the renderer skips; never a fake-valid segment,
        // never a throw that rejects the whole frame.
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

    /// Wire name of the segment kind — histogram/diagnostic key.
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

// MARK: - Tool events

/// One live tool-call row (`NativeToolCallEvent` in client-types-cloud.ts).
/// The TS type carries duplicated legacy aliases (actionName/toolName/name,
/// args/input, result/output, durationMs/duration); the `resolved*` accessors
/// collapse each alias group so views never branch on wire spelling. Every
/// field is optional so an alias-shaped event can never reject a frame.
struct TranscriptToolEvent: Codable, Equatable, Sendable {
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

    var resolvedName: String { actionName ?? toolName ?? name ?? "tool" }

    /// `running` | `completed` | `error` (+ passthrough of any explicit
    /// status); derived from the event type when the serializer omits it.
    var resolvedStatus: String {
        if let status, !status.isEmpty { return status }
        switch type {
        case "tool_error": return "error"
        case "tool_result": return "completed"
        default: return "running"
        }
    }

    var resolvedDurationMs: Double? { durationMs ?? duration }
    var resolvedArgs: TranscriptJSONValue? { args ?? input }
    var resolvedResult: TranscriptJSONValue? { result ?? output }
}

// MARK: - Secret request

/// Pending secret/OAuth side-channel (`ConversationSecretRequest`). The native
/// core renders this informationally only: secret VALUES must never travel the
/// plain-string `transcriptAction` channel, so collection stays with the
/// secure DOM form / a dedicated native secure sheet.
struct TranscriptSecretField: Codable, Equatable, Sendable {
    var name: String?
    var label: String?
    var input: String?
    var required: Bool?
}

struct TranscriptSecretForm: Codable, Equatable, Sendable {
    var kind: String?
    var submitLabel: String?
    var statusOnly: Bool?
    var provider: String?
    var fields: [TranscriptSecretField]?
}

struct TranscriptSecretRequest: Codable, Equatable, Sendable {
    var key: String?
    var reason: String?
    var status: String?
    var form: TranscriptSecretForm?
}

// MARK: - Message / frame

struct TranscriptTurnStatus: Codable, Equatable, Sendable {
    var kind: String
    var label: String?
}

struct TranscriptMessage: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var role: TranscriptRole
    var segments: [TranscriptSegment]
    var reasoning: String?
    var toolEvents: [TranscriptToolEvent]?
    var failureKind: String?
    var secretRequest: TranscriptSecretRequest?
    var streaming: Bool?
}

struct TranscriptFrame: Codable, Equatable, Sendable {
    /// `NATIVE_TRANSCRIPT_SCHEMA` in spec.ts. Additive changes stay within
    /// this tag; anything breaking bumps it, and the plugin rejects frames
    /// carrying a tag it does not support.
    static let supportedSchema = "eliza.native-transcript/v1"

    var schema: String
    var messages: [TranscriptMessage]
    var turnStatus: TranscriptTurnStatus?

    init(
        schema: String,
        messages: [TranscriptMessage],
        turnStatus: TranscriptTurnStatus? = nil
    ) {
        self.schema = schema
        self.messages = messages
        self.turnStatus = turnStatus
    }

    static var empty: TranscriptFrame {
        TranscriptFrame(schema: supportedSchema, messages: [])
    }
}
