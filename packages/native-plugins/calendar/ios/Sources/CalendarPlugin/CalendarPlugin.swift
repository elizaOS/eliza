import Foundation
import Capacitor
import EventKit
import UIKit

@objc(AppleCalendarPlugin)
public class AppleCalendarPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppleCalendarPlugin"
    public let jsName = "AppleCalendar"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listCalendars", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listEvents", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createEvent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateEvent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteEvent", returnType: CAPPluginReturnPromise),
    ]

    private let eventStore = EKEventStore()
    private lazy var isoWithFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private lazy var isoWithoutFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(permissionResult())
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        let status = EKEventStore.authorizationStatus(for: .event)
        if isGranted(status) || isDeniedOrRestricted(status) {
            call.resolve(permissionResult())
            return
        }

        if #available(iOS 17.0, *) {
            eventStore.requestFullAccessToEvents { [weak self] _, error in
                DispatchQueue.main.async {
                    var result = self?.permissionResult() ?? [
                        "calendar": "restricted",
                        "canRequest": false,
                    ]
                    if let error {
                        result["reason"] = error.localizedDescription
                    }
                    call.resolve(result)
                }
            }
        } else {
            eventStore.requestAccess(to: .event) { [weak self] _, error in
                DispatchQueue.main.async {
                    var result = self?.permissionResult() ?? [
                        "calendar": "restricted",
                        "canRequest": false,
                    ]
                    if let error {
                        result["reason"] = error.localizedDescription
                    }
                    call.resolve(result)
                }
            }
        }
    }

    @objc func listCalendars(_ call: CAPPluginCall) {
        guard hasFullAccess() else {
            call.resolve(permissionError())
            return
        }
        let defaultCalendar = eventStore.defaultCalendarForNewEvents
        let calendars = eventStore.calendars(for: .event).map {
            calendarJson($0, defaultCalendar: defaultCalendar)
        }
        call.resolve(["ok": true, "calendars": calendars])
    }

    @objc func listEvents(_ call: CAPPluginCall) {
        guard hasFullAccess() else {
            call.resolve(permissionError())
            return
        }
        guard let timeMin = parseDate(call.getString("timeMin") ?? ""),
              let timeMax = parseDate(call.getString("timeMax") ?? ""),
              timeMax > timeMin
        else {
            call.resolve(nativeError("Calendar event window is invalid."))
            return
        }

        let requestedCalendarId = (call.getString("calendarId") ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        var calendars: [EKCalendar]? = nil
        if !requestedCalendarId.isEmpty && requestedCalendarId != "all" {
            guard let calendar = calendar(withIdentifier: requestedCalendarId, requireWritable: false) else {
                call.resolve([
                    "ok": false,
                    "error": "not_found",
                    "message": "Apple Calendar was not found.",
                ])
                return
            }
            calendars = [calendar]
        }

        let predicate = eventStore.predicateForEvents(
            withStart: timeMin,
            end: timeMax,
            calendars: calendars
        )
        let events = eventStore.events(matching: predicate)
            .sorted { $0.startDate < $1.startDate }
            .map(eventJson)
        call.resolve(["ok": true, "events": events])
    }

    @objc func createEvent(_ call: CAPPluginCall) {
        guard hasFullAccess() else {
            call.resolve(permissionError())
            return
        }
        let event = EKEvent(eventStore: eventStore)
        if let error = applyEventPayload(call, to: event, requireTitle: true) {
            call.resolve(error)
            return
        }
        do {
            try eventStore.save(event, span: .thisEvent, commit: true)
            call.resolve(["ok": true, "event": eventJson(event)])
        } catch {
            call.resolve(nativeError("Failed to create Apple Calendar event: \(error.localizedDescription)"))
        }
    }

    @objc func updateEvent(_ call: CAPPluginCall) {
        guard hasFullAccess() else {
            call.resolve(permissionError())
            return
        }
        guard let eventId = nonEmptyString(call.getString("eventId")) else {
            call.resolve(nativeError("Calendar event id is required."))
            return
        }
        guard let item = eventStore.calendarItem(withIdentifier: eventId) as? EKEvent else {
            call.resolve([
                "ok": false,
                "error": "not_found",
                "message": "Apple Calendar event was not found.",
            ])
            return
        }
        guard item.calendar.allowsContentModifications else {
            call.resolve(nativeError("Apple Calendar event is not writable."))
            return
        }
        if let error = applyEventPayload(call, to: item, requireTitle: false) {
            call.resolve(error)
            return
        }
        do {
            try eventStore.save(item, span: .thisEvent, commit: true)
            call.resolve(["ok": true, "event": eventJson(item)])
        } catch {
            call.resolve(nativeError("Failed to update Apple Calendar event: \(error.localizedDescription)"))
        }
    }

    @objc func deleteEvent(_ call: CAPPluginCall) {
        guard hasFullAccess() else {
            call.resolve(permissionError())
            return
        }
        guard let eventId = nonEmptyString(call.getString("eventId")) else {
            call.resolve(nativeError("Calendar event id is required."))
            return
        }
        guard let event = eventStore.calendarItem(withIdentifier: eventId) as? EKEvent else {
            call.resolve([
                "ok": false,
                "error": "not_found",
                "message": "Apple Calendar event was not found.",
            ])
            return
        }
        do {
            try eventStore.remove(event, span: .thisEvent, commit: true)
            call.resolve(["ok": true])
        } catch {
            call.resolve(nativeError("Failed to delete Apple Calendar event: \(error.localizedDescription)"))
        }
    }

    private func permissionResult() -> [String: Any] {
        let status = EKEventStore.authorizationStatus(for: .event)
        return [
            "calendar": permissionString(status),
            "canRequest": permissionString(status) == "prompt",
            "reason": NSNull(),
        ]
    }

    private func permissionString(_ status: EKAuthorizationStatus) -> String {
        if isGranted(status) {
            return "granted"
        }
        if isDenied(status) {
            return "denied"
        }
        if isRestricted(status) {
            return "restricted"
        }
        return "prompt"
    }

    private func hasFullAccess() -> Bool {
        isGranted(EKEventStore.authorizationStatus(for: .event))
    }

    private func isGranted(_ status: EKAuthorizationStatus) -> Bool {
        if #available(iOS 17.0, *) {
            if status == .fullAccess {
                return true
            }
            if status == .writeOnly {
                return false
            }
        }
        return status == .authorized
    }

    private func isDenied(_ status: EKAuthorizationStatus) -> Bool {
        status == .denied
    }

    private func isRestricted(_ status: EKAuthorizationStatus) -> Bool {
        if #available(iOS 17.0, *), status == .writeOnly {
            return true
        }
        return status == .restricted
    }

    private func isDeniedOrRestricted(_ status: EKAuthorizationStatus) -> Bool {
        isDenied(status) || isRestricted(status)
    }

    private func permissionError() -> [String: Any] {
        [
            "ok": false,
            "error": "permission",
            "message": "Apple Calendar access has not been granted.",
        ]
    }

    private func nativeError(_ message: String) -> [String: Any] {
        [
            "ok": false,
            "error": "native_error",
            "message": message,
        ]
    }

    private func nonEmptyString(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty
        else {
            return nil
        }
        return trimmed
    }

    private func parseDate(_ value: String) -> Date? {
        if let date = isoWithFractionalSeconds.date(from: value) {
            return date
        }
        return isoWithoutFractionalSeconds.date(from: value)
    }

    private func isoString(_ date: Date?) -> String {
        guard let date else { return "" }
        return isoWithFractionalSeconds.string(from: date)
    }

    private func calendar(withIdentifier identifier: String, requireWritable: Bool) -> EKCalendar? {
        if identifier.isEmpty || identifier == "primary" {
            if let calendar = eventStore.defaultCalendarForNewEvents,
               !requireWritable || calendar.allowsContentModifications
            {
                return calendar
            }
            if requireWritable {
                return eventStore.calendars(for: .event)
                    .first(where: { $0.allowsContentModifications })
            }
            return eventStore.defaultCalendarForNewEvents
        }
        guard let calendar = eventStore.calendars(for: .event)
            .first(where: { $0.calendarIdentifier == identifier })
        else {
            return nil
        }
        if requireWritable && !calendar.allowsContentModifications {
            return nil
        }
        return calendar
    }

    private func calendarJson(_ calendar: EKCalendar, defaultCalendar: EKCalendar?) -> [String: Any] {
        let color = UIColor(cgColor: calendar.cgColor)
        let components = color.resolvedColor(with: UITraitCollection.current).cgColor.components ?? []
        let red = components.indices.contains(0) ? components[0] : 0
        let green = components.indices.contains(1) ? components[1] : red
        let blue = components.indices.contains(2) ? components[2] : red
        let hex = String(
            format: "#%02X%02X%02X",
            Int(max(0, min(1, red)) * 255),
            Int(max(0, min(1, green)) * 255),
            Int(max(0, min(1, blue)) * 255)
        )
        return [
            "calendarId": calendar.calendarIdentifier,
            "summary": calendar.title,
            "description": calendar.source.title,
            "primary": calendar.calendarIdentifier == defaultCalendar?.calendarIdentifier,
            "accessRole": calendar.allowsContentModifications ? "writer" : "reader",
            "backgroundColor": hex,
            "foregroundColor": NSNull(),
            "timeZone": TimeZone.current.identifier,
            "selected": true,
        ]
    }

    private func participantEmail(_ participant: EKParticipant) -> String? {
        guard participant.url.scheme?.lowercased() == "mailto" else {
            return nil
        }
        let raw = participant.url.absoluteString
        let prefix = "mailto:"
        guard raw.lowercased().hasPrefix(prefix) else {
            return nil
        }
        let address = String(raw.dropFirst(prefix.count))
        return address.removingPercentEncoding ?? address
    }

    private func participantStatus(_ status: EKParticipantStatus) -> String {
        switch status {
        case .unknown: return "unknown"
        case .pending: return "pending"
        case .accepted: return "accepted"
        case .declined: return "declined"
        case .tentative: return "tentative"
        case .delegated: return "delegated"
        case .completed: return "completed"
        case .inProcess: return "in_process"
        @unknown default: return "unknown"
        }
    }

    private func participantJson(_ participant: EKParticipant) -> [String: Any] {
        [
            "email": participantEmail(participant) ?? NSNull(),
            "displayName": participant.name ?? NSNull(),
            "responseStatus": participantStatus(participant.participantStatus),
            "self": participant.isCurrentUser,
            "organizer": participant.participantRole == .chair,
            "optional": participant.participantRole == .optional,
        ]
    }

    private func eventStatus(_ status: EKEventStatus) -> String {
        switch status {
        case .none: return "none"
        case .confirmed: return "confirmed"
        case .tentative: return "tentative"
        case .canceled: return "cancelled"
        @unknown default: return "unknown"
        }
    }

    private func eventJson(_ event: EKEvent) -> [String: Any] {
        let identifier = event.calendarItemIdentifier
        return [
            "id": identifier,
            "externalId": identifier,
            "calendarId": event.calendar.calendarIdentifier,
            "calendarSummary": event.calendar.title,
            "title": event.title?.isEmpty == false ? event.title as Any : "(untitled)",
            "description": event.notes ?? "",
            "location": event.location ?? "",
            "status": eventStatus(event.status),
            "startAt": isoString(event.startDate),
            "endAt": isoString(event.endDate),
            "isAllDay": event.isAllDay,
            "timezone": event.timeZone?.identifier ?? NSNull(),
            "htmlLink": NSNull(),
            "conferenceLink": NSNull(),
            "organizer": event.organizer.map(participantJson) ?? NSNull(),
            "attendees": event.attendees?.map(participantJson) ?? [],
        ]
    }

    private func applyEventPayload(
        _ call: CAPPluginCall,
        to event: EKEvent,
        requireTitle: Bool
    ) -> [String: Any]? {
        if let attendees = call.options["attendees"] as? [Any], !attendees.isEmpty {
            return [
                "ok": false,
                "error": "unsupported_feature",
                "message": "Apple Calendar does not allow this app to create or edit event invitees through EventKit. Remove attendees or use Google Calendar for invited meetings.",
            ]
        }

        if call.options.keys.contains("title") || requireTitle {
            guard let title = nonEmptyString(call.getString("title")) else {
                return nativeError("Calendar event title is required.")
            }
            event.title = title
        }
        if call.options.keys.contains("description") {
            event.notes = call.getString("description")
        }
        if call.options.keys.contains("location") {
            event.location = call.getString("location")
        }
        if let timeZoneName = call.getString("timeZone"),
           let timeZone = TimeZone(identifier: timeZoneName)
        {
            event.timeZone = timeZone
        }
        if call.options.keys.contains("calendarId") {
            guard let calendar = calendar(
                withIdentifier: call.getString("calendarId") ?? "",
                requireWritable: true
            ) else {
                return nativeError("The selected Apple Calendar is not writable or was not found.")
            }
            event.calendar = calendar
        }
        if call.options.keys.contains("isAllDay") {
            event.isAllDay = call.getBool("isAllDay") ?? false
        }
        if call.options.keys.contains("startAt") {
            guard let start = parseDate(call.getString("startAt") ?? "") else {
                return nativeError("Calendar event startAt is invalid.")
            }
            event.startDate = start
        }
        if call.options.keys.contains("endAt") {
            guard let end = parseDate(call.getString("endAt") ?? "") else {
                return nativeError("Calendar event endAt is invalid.")
            }
            event.endDate = end
        }
        guard event.startDate != nil, event.endDate != nil else {
            return nativeError("Calendar event startAt and endAt are required.")
        }
        guard event.endDate > event.startDate else {
            return nativeError("Calendar event endAt must be later than startAt.")
        }
        if event.calendar == nil {
            guard let calendar = calendar(withIdentifier: "primary", requireWritable: true) else {
                return nativeError("No writable Apple Calendar is available.")
            }
            event.calendar = calendar
        }
        return nil
    }
}
