/**
 * iOS decoder, reducer, and SwiftUI renderer for
 * `eliza.native-transcript/v1`. The reducer mirrors the shared structural
 * ordering, dedupe, late-event, and cancellation rules and never interprets
 * transcript text as control state.
 */

import CoreFoundation
import Foundation
#if canImport(SwiftUI)
import SwiftUI
#endif

public struct NativeTranscriptApplyResult {
    public let view: [String: Any]
    public let rejectedIndexes: [Int]
}

public enum NativeTranscriptReducerError: Error {
    case invalidEnvelope(String)
    case invalidEvent(String)
}

public final class NativeTranscriptReducer {
    public static let schema = "eliza.native-transcript/v1"

    private struct Entry {
        let item: [String: Any]
        let order: Int64
        let revision: Int64
    }

    private var entries: [String: Entry] = [:]
    private var appliedSequences: Set<Int64> = []
    private var speaking: [String: Any]?
    private var connection = "live"
    private var lastSequence: Int64 = 0

    public init() {}

    public func applyEnvelope(_ envelope: [String: Any]) throws -> NativeTranscriptApplyResult {
        guard envelope["schema"] as? String == Self.schema else {
            throw NativeTranscriptReducerError.invalidEnvelope("unsupported schema")
        }
        guard let rawEvents = envelope["events"] as? [Any] else {
            throw NativeTranscriptReducerError.invalidEnvelope("events must be an array")
        }

        var rejected: [Int] = []
        for (index, rawEvent) in rawEvents.enumerated() {
            do {
                apply(try Self.decode(rawEvent))
            } catch {
                // error-policy:J3 malformed bridge input is explicitly reported
                // by source index while valid siblings continue through the fold.
                rejected.append(index)
            }
        }
        return NativeTranscriptApplyResult(view: viewModel(), rejectedIndexes: rejected)
    }

    public func viewModel() -> [String: Any] {
        let items = entries.values.sorted {
            if $0.order != $1.order { return $0.order < $1.order }
            return Self.string($0.item["id"]) < Self.string($1.item["id"])
        }.map(\.item)
        return [
            "items": items,
            "speaking": speaking ?? NSNull(),
            "connection": connection,
            "lastSeq": lastSequence,
        ]
    }

    private static func decode(_ raw: Any) throws -> [String: Any] {
        guard let source = raw as? [String: Any] else { throw invalid("event must be an object") }
        let type = try requiredString(source, "type")
        let sequence = try requiredSequence(source)
        if let at = source["at"], !isFiniteNumber(at) { throw invalid("invalid at") }

        var event: [String: Any] = ["type": type, "seq": sequence]
        if let at = source["at"] { event["at"] = at }
        switch type {
        case "stt.partial":
            event["turnId"] = try requiredNonEmptyString(source, "turnId")
            event["text"] = try requiredString(source, "text")
        case "stt.final":
            event["turnId"] = try requiredNonEmptyString(source, "turnId")
            event["text"] = try requiredString(source, "text")
            if let words = source["words"] { event["words"] = try decodeWords(words) }
        case "agent.text":
            event["messageId"] = try requiredNonEmptyString(source, "messageId")
            event["text"] = try requiredString(source, "text")
            event["final"] = try requiredBool(source, "final")
            try copyOptionalNonEmptyString(source, &event, "turnId")
        case "tool.state":
            event["callId"] = try requiredNonEmptyString(source, "callId")
            event["name"] = try requiredNonEmptyString(source, "name")
            let phase = try requiredString(source, "phase")
            guard ["started", "succeeded", "failed"].contains(phase) else {
                throw invalid("invalid tool phase")
            }
            event["phase"] = phase
            try copyOptionalString(source, &event, "detail")
            try copyOptionalNonEmptyString(source, &event, "turnId")
        case "tts.audio":
            event["utteranceId"] = try requiredNonEmptyString(source, "utteranceId")
            let phase = try requiredString(source, "phase")
            guard phase == "started" || phase == "ended" else { throw invalid("invalid audio phase") }
            event["phase"] = phase
            try copyOptionalNonEmptyString(source, &event, "messageId")
        case "cancel":
            let scope = try requiredString(source, "scope")
            guard scope == "turn" || scope == "all" else { throw invalid("invalid cancel scope") }
            event["scope"] = scope
            if scope == "turn" {
                event["turnId"] = try requiredNonEmptyString(source, "turnId")
            } else {
                try copyOptionalNonEmptyString(source, &event, "turnId")
            }
            try copyOptionalString(source, &event, "reason")
        case "error":
            event["code"] = try requiredNonEmptyString(source, "code")
            event["retryable"] = try requiredBool(source, "retryable")
            try copyOptionalString(source, &event, "message")
        case "reconnect":
            let phase = try requiredString(source, "phase")
            guard phase == "lost" || phase == "restored" else { throw invalid("invalid reconnect phase") }
            event["phase"] = phase
            event["attempt"] = try requiredNonNegativeInteger(source, "attempt")
        default:
            throw invalid("unknown event type")
        }
        return event
    }

    private func apply(_ event: [String: Any]) {
        let sequence = Self.integer(event["seq"])
        if appliedSequences.contains(sequence) { return }
        appliedSequences.insert(sequence)
        lastSequence = max(lastSequence, sequence)

        switch Self.string(event["type"]) {
        case "stt.partial":
            let id = Self.string(event["turnId"])
            let itemKey = key("user", id)
            if let previous = entries[itemKey], Self.string(previous.item["status"]) != "partial" { return }
            upsert(itemKey, sequence) { previous in
                [
                    "kind": "user",
                    "id": id,
                    "status": "partial",
                    "text": Self.string(event["text"]),
                    "words": previous?["words"] as? [Any] ?? [],
                ]
            }
        case "stt.final":
            let id = Self.string(event["turnId"])
            upsert(key("user", id), sequence) { _ in
                [
                    "kind": "user",
                    "id": id,
                    "status": "final",
                    "text": Self.string(event["text"]),
                    "words": event["words"] as? [Any] ?? [],
                ]
            }
        case "agent.text":
            let id = Self.string(event["messageId"])
            let itemKey = key("agent", id)
            if
                let previous = entries[itemKey],
                Self.string(previous.item["status"]) == "final",
                !Self.bool(event["final"])
            { return }
            upsert(itemKey, sequence) { previous in
                var item: [String: Any] = [
                    "kind": "agent",
                    "id": id,
                    "status": Self.bool(event["final"]) ? "final" : "streaming",
                    "text": Self.string(event["text"]),
                ]
                Self.copyEventOrPrevious(event, previous, &item, "turnId")
                return item
            }
        case "tool.state":
            let id = Self.string(event["callId"])
            let itemKey = key("tool", id)
            if let previous = entries[itemKey] {
                let status = Self.string(previous.item["status"])
                if (status == "succeeded" || status == "failed") && Self.string(event["phase"]) == "started" {
                    return
                }
            }
            upsert(itemKey, sequence) { previous in
                let phase = Self.string(event["phase"])
                var item: [String: Any] = [
                    "kind": "tool",
                    "id": id,
                    "status": phase == "started" ? "running" : phase == "succeeded" ? "succeeded" : "failed",
                    "name": Self.string(event["name"]),
                ]
                Self.copyEventOrPrevious(event, previous, &item, "detail")
                Self.copyEventOrPrevious(event, previous, &item, "turnId")
                return item
            }
        case "tts.audio":
            let utteranceId = Self.string(event["utteranceId"])
            if Self.string(event["phase"]) == "started" {
                speaking = ["utteranceId": utteranceId]
                if let messageId = event["messageId"] { speaking?["messageId"] = messageId }
            } else if Self.string(speaking?["utteranceId"]) == utteranceId {
                speaking = nil
            }
        case "cancel":
            applyCancel(event, sequence)
        case "error":
            let id = "error:\(sequence)"
            upsert(id, sequence) { _ in
                var item: [String: Any] = [
                    "kind": "error",
                    "id": id,
                    "code": Self.string(event["code"]),
                    "retryable": Self.bool(event["retryable"]),
                ]
                if let message = event["message"] { item["message"] = message }
                return item
            }
        case "reconnect":
            let phase = Self.string(event["phase"])
            connection = phase == "lost" ? "lost" : "live"
            let id = "reconnect:\(sequence)"
            upsert(id, sequence) { _ in
                [
                    "kind": "reconnect",
                    "id": id,
                    "phase": phase,
                    "attempt": Self.integer(event["attempt"]),
                ]
            }
        default:
            preconditionFailure("decoded native transcript type is unsupported")
        }
    }

    private func applyCancel(_ event: [String: Any], _ sequence: Int64) {
        let scope = Self.string(event["scope"])
        let turnId = event["turnId"].map(Self.string)
        var cancelledMessageIds: Set<String> = []
        for itemKey in Array(entries.keys) {
            guard let entry = entries[itemKey], Self.isInFlight(entry.item) else { continue }
            if scope == "turn" && !Self.belongsToTurn(entry.item, turnId ?? "") { continue }
            var item = entry.item
            item["status"] = "cancelled"
            if Self.string(item["kind"]) == "agent" { cancelledMessageIds.insert(Self.string(item["id"])) }
            entries[itemKey] = Entry(item: item, order: entry.order, revision: max(entry.revision, sequence))
        }
        if
            speaking != nil &&
            (scope == "all" || speaking?["messageId"].map(Self.string).map(cancelledMessageIds.contains) == true)
        {
            speaking = nil
        }
    }

    private func upsert(
        _ itemKey: String,
        _ sequence: Int64,
        build: ([String: Any]?) -> [String: Any]
    ) {
        let previous = entries[itemKey]
        if let previous, sequence <= previous.revision { return }
        entries[itemKey] = Entry(
            item: build(previous?.item),
            order: previous?.order ?? sequence,
            revision: sequence
        )
    }

    private static func isInFlight(_ item: [String: Any]) -> Bool {
        let kind = string(item["kind"])
        let status = string(item["status"])
        return
            (kind == "user" && status == "partial") ||
            (kind == "agent" && status == "streaming") ||
            (kind == "tool" && status == "running")
    }

    private static func belongsToTurn(_ item: [String: Any], _ turnId: String) -> Bool {
        let kind = string(item["kind"])
        if kind == "user" { return string(item["id"]) == turnId }
        return (kind == "agent" || kind == "tool") && string(item["turnId"]) == turnId
    }

    private static func copyEventOrPrevious(
        _ event: [String: Any],
        _ previous: [String: Any]?,
        _ target: inout [String: Any],
        _ field: String
    ) {
        if let value = event[field] { target[field] = value }
        else if let value = previous?[field] { target[field] = value }
    }

    private static func decodeWords(_ raw: Any) throws -> [[String: Any]] {
        guard let values = raw as? [Any] else { throw invalid("invalid words") }
        return try values.map { value in
            guard let source = value as? [String: Any] else { throw invalid("invalid word") }
            let text = try requiredString(source, "text")
            let start = try requiredFiniteNumber(source, "startMs")
            let end = try requiredFiniteNumber(source, "endMs")
            guard start >= 0 && end >= start else { throw invalid("invalid word timing") }
            return ["text": text, "startMs": start, "endMs": end]
        }
    }

    private static func requiredSequence(_ source: [String: Any]) throws -> Int64 {
        let sequence = try requiredNonNegativeInteger(source, "seq")
        guard sequence <= 9_007_199_254_740_991 else { throw invalid("unsafe sequence") }
        return sequence
    }

    private static func requiredNonNegativeInteger(_ source: [String: Any], _ field: String) throws -> Int64 {
        guard let value = source[field], isFiniteNumber(value) else { throw invalid("invalid \(field)") }
        let doubleValue = (value as! NSNumber).doubleValue
        guard doubleValue >= 0 && doubleValue.rounded() == doubleValue && doubleValue <= Double(Int64.max) else {
            throw invalid("invalid \(field)")
        }
        return Int64(doubleValue)
    }

    private static func requiredFiniteNumber(_ source: [String: Any], _ field: String) throws -> Double {
        guard let value = source[field], isFiniteNumber(value) else { throw invalid("invalid \(field)") }
        return (value as! NSNumber).doubleValue
    }

    private static func isFiniteNumber(_ value: Any) -> Bool {
        guard let number = value as? NSNumber, !isBoolean(number) else { return false }
        return number.doubleValue.isFinite
    }

    private static func isBoolean(_ value: NSNumber) -> Bool {
        CFGetTypeID(value) == CFBooleanGetTypeID()
    }

    private static func requiredString(_ source: [String: Any], _ field: String) throws -> String {
        guard let value = source[field] as? String else { throw invalid("invalid \(field)") }
        return value
    }

    private static func requiredNonEmptyString(_ source: [String: Any], _ field: String) throws -> String {
        let value = try requiredString(source, field)
        guard !value.isEmpty else { throw invalid("empty \(field)") }
        return value
    }

    private static func requiredBool(_ source: [String: Any], _ field: String) throws -> Bool {
        guard let number = source[field] as? NSNumber, isBoolean(number) else { throw invalid("invalid \(field)") }
        return number.boolValue
    }

    private static func copyOptionalString(
        _ source: [String: Any],
        _ target: inout [String: Any],
        _ field: String
    ) throws {
        guard source.keys.contains(field) else { return }
        target[field] = try requiredString(source, field)
    }

    private static func copyOptionalNonEmptyString(
        _ source: [String: Any],
        _ target: inout [String: Any],
        _ field: String
    ) throws {
        guard source.keys.contains(field) else { return }
        target[field] = try requiredNonEmptyString(source, field)
    }

    private static func integer(_ value: Any?) -> Int64 { (value as? NSNumber)?.int64Value ?? 0 }
    private static func bool(_ value: Any?) -> Bool { (value as? NSNumber)?.boolValue ?? false }
    private static func string(_ value: Any?) -> String { value as? String ?? "" }
    private func key(_ kind: String, _ id: String) -> String { "\(kind):\(id)" }
    private static func invalid(_ message: String) -> NativeTranscriptReducerError { .invalidEvent(message) }
}

#if canImport(SwiftUI)
/// SwiftUI projection of the shared view model for app-owned native surfaces.
public struct NativeTranscriptView: View {
    public let viewModel: [String: Any]

    public init(viewModel: [String: Any]) { self.viewModel = viewModel }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                row(item)
            }
            if (viewModel["connection"] as? String) == "lost" {
                Text("Connection lost").foregroundStyle(.secondary)
            }
            if !(viewModel["speaking"] is NSNull) {
                Text("Eliza is speaking").foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var items: [[String: Any]] { viewModel["items"] as? [[String: Any]] ?? [] }

    @ViewBuilder
    private func row(_ item: [String: Any]) -> some View {
        let kind = item["kind"] as? String ?? ""
        let text: String = {
            if kind == "tool" {
                return "\(item["name"] as? String ?? "") · \(item["status"] as? String ?? "")"
            }
            if kind == "error" {
                return item["message"] as? String ?? item["code"] as? String ?? "Error"
            }
            if kind == "reconnect" {
                return "Connection \(item["phase"] as? String ?? "")"
            }
            return item["text"] as? String ?? ""
        }()
        HStack {
            if kind == "user" { Spacer(minLength: 24) }
            Text(text)
                .foregroundStyle(kind == "error" ? Color.red : Color.primary)
                .multilineTextAlignment(kind == "user" ? .trailing : .leading)
                .accessibilityLabel("\(kind): \(text)")
            if kind != "user" { Spacer(minLength: 24) }
        }
    }
}
#endif
