/**
 * Capacitor bridge for EventKit authorization and calendar-event operations.
 * Full access supports CRUD; write-only access is isolated to fully specified
 * creation on the system default calendar and never returns EventKit readback.
 */
import Foundation
import Capacitor
import EventKit
import UIKit

@objc(AppleCalendarPlugin)
public class AppleCalendarPlugin: CAPPlugin, CAPBridgedPlugin {
    private enum RequestedCalendarAccess {
        case fullAccess
        case writeOnly
    }

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
    private let maxTitleLength = 512
    private let maxDescriptionLength = 20000
    private let maxLocationLength = 1024
    private let unsupportedRecurrenceFields = [
        "recurrence",
        "recurrenceRule",
        "recurrenceRules",
        "rrule",
    ]
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

    public override func load() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(calendarStoreChanged),
            name: .EKEventStoreChanged,
            object: eventStore
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func calendarStoreChanged() {
        notifyListeners(
            "calendarStoreChanged",
            data: ["observedAt": isoString(Date())],
            retainUntilConsumed: true
        )
    }

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(permissionResult())
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        guard let requestedAccess = requestedCalendarAccess(call) else {
            call.reject("Calendar access must be either full_access or write_only.")
            return
        }
        let status = EKEventStore.authorizationStatus(for: .event)
        if hasRequestedAccess(requestedAccess, status: status) || isDeniedOrRestricted(status) {
            call.resolve(permissionResult())
            return
        }

        if #available(iOS 17.0, *) {
            switch requestedAccess {
            case .fullAccess:
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
            case .writeOnly:
                eventStore.requestWriteOnlyAccessToEvents { [weak self] _, error in
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
            call.resolve(fullAccessError(operation: "list calendars"))
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
            call.resolve(fullAccessError(operation: "read events"))
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
        let writeOnly = hasWriteOnlyAccess()
        guard hasFullAccess() || writeOnly else {
            call.resolve(permissionError())
            return
        }
        let event = EKEvent(eventStore: eventStore)
        if let error = applyEventPayload(
            call,
            to: event,
            requireTitle: true,
            writeOnly: writeOnly
        ) {
            call.resolve(error)
            return
        }
        do {
            try eventStore.save(event, span: .thisEvent, commit: true)
            if writeOnly {
                call.resolve([
                    "ok": true,
                    "receipt": [
                        "accessLevel": "write_only",
                        "destination": "default_calendar",
                        "eventId": NSNull(),
                        "readBackAvailable": false,
                    ],
                ])
                return
            }
            call.resolve([
                "ok": true,
                "event": eventJson(event),
                "receipt": [
                    "accessLevel": "full_access",
                    "destination": "resolved_calendar",
                    "eventId": event.calendarItemIdentifier,
                    "readBackAvailable": true,
                ],
            ])
        } catch {
            call.resolve(nativeError("Failed to create Apple Calendar event: \(error.localizedDescription)"))
        }
    }

    @objc func updateEvent(_ call: CAPPluginCall) {
        guard hasFullAccess() else {
            call.resolve(fullAccessError(operation: "update events"))
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
        if let error = applyEventPayload(
            call,
            to: item,
            requireTitle: false,
            writeOnly: false
        ) {
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
            call.resolve(fullAccessError(operation: "delete events"))
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
        let permission = permissionString(status)
        let reason: Any = permission == "write_only"
            ? "Write-only access can add new events to the default calendar, but cannot read or change existing events."
            : NSNull()
        return [
            "calendar": permission,
            "canRequest": permission == "prompt" || permission == "write_only",
            "reason": reason,
        ]
    }

    private func permissionString(_ status: EKAuthorizationStatus) -> String {
        if hasFullAccess(status) {
            return "granted"
        }
        if hasWriteOnlyAccess(status) {
            return "write_only"
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
        hasFullAccess(EKEventStore.authorizationStatus(for: .event))
    }

    private func hasFullAccess(_ status: EKAuthorizationStatus) -> Bool {
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

    private func hasWriteOnlyAccess() -> Bool {
        hasWriteOnlyAccess(EKEventStore.authorizationStatus(for: .event))
    }

    private func hasWriteOnlyAccess(_ status: EKAuthorizationStatus) -> Bool {
        if #available(iOS 17.0, *) {
            return status == .writeOnly
        }
        return false
    }

    private func isDenied(_ status: EKAuthorizationStatus) -> Bool {
        status == .denied
    }

    private func isRestricted(_ status: EKAuthorizationStatus) -> Bool {
        return status == .restricted
    }

    private func isDeniedOrRestricted(_ status: EKAuthorizationStatus) -> Bool {
        isDenied(status) || isRestricted(status)
    }

    private func requestedCalendarAccess(_ call: CAPPluginCall) -> RequestedCalendarAccess? {
        let value = (call.getString("access") ?? "full_access")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        switch value {
        case "full_access": return .fullAccess
        case "write_only": return .writeOnly
        default: return nil
        }
    }

    private func hasRequestedAccess(
        _ requestedAccess: RequestedCalendarAccess,
        status: EKAuthorizationStatus
    ) -> Bool {
        switch requestedAccess {
        case .fullAccess:
            return hasFullAccess(status)
        case .writeOnly:
            return hasFullAccess(status) || hasWriteOnlyAccess(status)
        }
    }

    private func permissionError() -> [String: Any] {
        [
            "ok": false,
            "error": "permission",
            "message": "Apple Calendar access has not been granted.",
        ]
    }

    private func fullAccessError(operation: String) -> [String: Any] {
        if hasWriteOnlyAccess() {
            return [
                "ok": false,
                "error": "write_only_access",
                "message": "Write-only Apple Calendar access can create events on the default calendar, but cannot \(operation).",
            ]
        }
        return permissionError()
    }

    private func writeOnlyDefaultCalendarError() -> [String: Any] {
        [
            "ok": false,
            "error": "write_only_default_calendar_only",
            "message": "Write-only Apple Calendar access can create events only on the default calendar.",
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
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        if let date = isoWithFractionalSeconds.date(from: value) {
            return date
        }
        return isoWithoutFractionalSeconds.date(from: value)
    }

    private func textValue(
        _ call: CAPPluginCall,
        key: String,
        maxLength: Int,
        required: Bool
    ) -> (value: String?, error: [String: Any]?) {
        let rawValue = call.options[key]
        if rawValue == nil || rawValue is NSNull {
            if required {
                return (nil, nativeError("Calendar event \(key) is required."))
            }
            return (nil, nil)
        }
        guard rawValue is String else {
            return (nil, nativeError("Calendar event \(key) must be a string."))
        }
        guard let value = call.getString(key) else {
            if required {
                return (nil, nativeError("Calendar event \(key) is required."))
            }
            return (nil, nil)
        }
        guard value.count <= maxLength else {
            return (nil, nativeError("Calendar event \(key) is too long."))
        }
        return (value, nil)
    }

    private func isoString(_ date: Date?) -> String {
        guard let date else { return "" }
        return isoWithFractionalSeconds.string(from: date)
    }

    private func calendar(withIdentifier identifier: String, requireWritable: Bool) -> EKCalendar? {
        if identifier.isEmpty || identifier == "primary" || identifier == "default" {
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
            "sourceIdentifier": calendar.source.sourceIdentifier,
            "sourceTitle": calendar.source.title,
            "sourceType": sourceType(calendar.source.sourceType),
        ]
    }

    private func sourceType(_ type: EKSourceType) -> String {
        switch type {
        case .local: return "local"
        case .exchange: return "exchange"
        case .calDAV: return "caldav"
        case .mobileMe: return "mobile_me"
        case .subscribed: return "subscribed"
        case .birthdays: return "birthdays"
        @unknown default: return "unknown"
        }
    }

    private func recurrenceFrequency(_ frequency: EKRecurrenceFrequency) -> String {
        switch frequency {
        case .daily: return "daily"
        case .weekly: return "weekly"
        case .monthly: return "monthly"
        case .yearly: return "yearly"
        @unknown default: return "unknown"
        }
    }

    private func recurrenceRuleJson(_ rule: EKRecurrenceRule) -> [String: Any] {
        [
            "frequency": recurrenceFrequency(rule.frequency),
            "interval": rule.interval,
            "occurrenceCount": rule.recurrenceEnd?.occurrenceCount ?? NSNull(),
            "endDate": rule.recurrenceEnd?.endDate.map(isoString) ?? NSNull(),
        ]
    }

    private func reminderJson(_ alarm: EKAlarm) -> [String: Any] {
        [
            "relativeOffsetSeconds": alarm.relativeOffset,
            "absoluteDate": alarm.absoluteDate.map(isoString) ?? NSNull(),
            "locationTitle": alarm.structuredLocation?.title ?? NSNull(),
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

    private func eventAvailability(_ availability: EKEventAvailability) -> String {
        switch availability {
        case .notSupported: return "not_supported"
        case .busy: return "busy"
        case .free: return "free"
        case .tentative: return "tentative"
        case .unavailable: return "unavailable"
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
            "availability": eventAvailability(event.availability),
            "startAt": isoString(event.startDate),
            "endAt": isoString(event.endDate),
            "isAllDay": event.isAllDay,
            "timezone": event.timeZone?.identifier ?? NSNull(),
            "htmlLink": NSNull(),
            "conferenceLink": NSNull(),
            "organizer": event.organizer.map(participantJson) ?? NSNull(),
            "attendees": event.attendees?.map(participantJson) ?? [],
            "iCalUID": event.calendarItemExternalIdentifier ?? NSNull(),
            "originalStartAt": event.occurrenceDate.map(isoString) ?? NSNull(),
            "lastModifiedAt": event.lastModifiedDate.map(isoString) ?? NSNull(),
            "recurrenceRules": event.recurrenceRules?.map(recurrenceRuleJson) ?? [],
            "reminders": event.alarms?.map(reminderJson) ?? [],
            "sourceIdentifier": event.calendar.source.sourceIdentifier,
            "sourceTitle": event.calendar.source.title,
            "sourceType": sourceType(event.calendar.source.sourceType),
        ]
    }

    private func applyEventPayload(
        _ call: CAPPluginCall,
        to event: EKEvent,
        requireTitle: Bool,
        writeOnly: Bool
    ) -> [String: Any]? {
        for key in unsupportedRecurrenceFields where call.options.keys.contains(key) {
            return [
                "ok": false,
                "error": "unsupported_feature",
                "message": "Apple Calendar recurrence editing is not supported by this bridge.",
            ]
        }

        if call.options.keys.contains("attendees") {
            guard let attendees = call.options["attendees"] as? [Any] else {
                return nativeError("Calendar event attendees must be an array.")
            }
            if !attendees.isEmpty {
                return [
                    "ok": false,
                    "error": "unsupported_feature",
                    "message": "Apple Calendar does not allow this app to create or edit event invitees through EventKit. Remove attendees or use Google Calendar for invited meetings.",
                ]
            }
        }

        if call.options.keys.contains("title") || requireTitle {
            let titleResult = textValue(
                call,
                key: "title",
                maxLength: maxTitleLength,
                required: true
            )
            if let error = titleResult.error {
                return error
            }
            guard let title = nonEmptyString(titleResult.value) else {
                return nativeError("Calendar event title is required.")
            }
            event.title = title
        }
        if call.options.keys.contains("description") {
            let descriptionResult = textValue(
                call,
                key: "description",
                maxLength: maxDescriptionLength,
                required: false
            )
            if let error = descriptionResult.error {
                return error
            }
            event.notes = descriptionResult.value
        }
        if call.options.keys.contains("location") {
            let locationResult = textValue(
                call,
                key: "location",
                maxLength: maxLocationLength,
                required: false
            )
            if let error = locationResult.error {
                return error
            }
            event.location = locationResult.value
        }
        if call.options.keys.contains("timeZone") {
            guard let timeZoneName = nonEmptyString(call.getString("timeZone")) else {
                return nativeError("Calendar event timeZone is invalid.")
            }
            guard let timeZone = TimeZone(identifier: timeZoneName) else {
                return nativeError("Calendar event timeZone is invalid.")
            }
            event.timeZone = timeZone
        }
        if call.options.keys.contains("calendarId") {
            guard call.options["calendarId"] is String,
                  let calendarId = call.getString("calendarId")
            else {
                return nativeError("Calendar event calendarId must be a string.")
            }
            let requestedCalendarId = calendarId
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if writeOnly {
                guard requestedCalendarId.isEmpty ||
                        requestedCalendarId == "primary" ||
                        requestedCalendarId == "default"
                else {
                    return writeOnlyDefaultCalendarError()
                }
                guard let defaultCalendar = eventStore.defaultCalendarForNewEvents else {
                    return nativeError("No default Apple Calendar is available.")
                }
                event.calendar = defaultCalendar
            } else {
                guard let calendar = calendar(
                    withIdentifier: requestedCalendarId,
                    requireWritable: true
                ) else {
                    return nativeError("The selected Apple Calendar is not writable or was not found.")
                }
                event.calendar = calendar
            }
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
            if writeOnly {
                guard let defaultCalendar = eventStore.defaultCalendarForNewEvents else {
                    return nativeError("No default Apple Calendar is available.")
                }
                event.calendar = defaultCalendar
            } else {
                guard let calendar = calendar(withIdentifier: "primary", requireWritable: true) else {
                    return nativeError("No writable Apple Calendar is available.")
                }
                event.calendar = calendar
            }
        }
        return nil
    }
}
