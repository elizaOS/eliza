import Foundation
import UserNotifications

// macOS native alarm helper.
//
// Reads one JSON request from stdin and writes exactly one JSON response to
// stdout before exiting. All diagnostic messages go to stderr so the parent
// process can cleanly parse stdout as JSON.
//
// Request shape:
//   { "action": "schedule" | "cancel" | "list" | "permission",
//     "id": "...",          // required for schedule/cancel
//     "timeIso": "...",     // required for schedule (ISO-8601)
//     "title": "...",       // required for schedule
//     "body": "...",        // optional for schedule
//     "sound": "..." }      // optional for schedule ("default" or named)
//
// Response shape:
//   { "success": true, ... fields per action ... }
//   { "success": false, "error": "reason" }

struct Request: Decodable {
    let action: String
    let id: String?
    let timeIso: String?
    let title: String?
    let body: String?
    let sound: String?
}

enum HelperError: Error {
    case invalidRequest(String)
    case permissionDenied(String)
    case scheduleFailed(String)
}

func writeJSON(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func writeError(_ message: String) {
    writeJSON(["success": false, "error": message])
}

func log(_ message: String) {
    FileHandle.standardError.write("[macosalarm-helper] \(message)\n".data(using: .utf8)!)
}

func readRequest() throws -> Request {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty else {
        throw HelperError.invalidRequest("empty stdin")
    }
    let decoder = JSONDecoder()
    do {
        return try decoder.decode(Request.self, from: data)
    } catch {
        throw HelperError.invalidRequest("could not decode request json: \(error.localizedDescription)")
    }
}

// UNUserNotificationCenter APIs are mostly async with completion handlers.
// We drive them synchronously from a CLI using DispatchSemaphore.

func ensureAuthorization() throws {
    let center = UNUserNotificationCenter.current()
    let sem = DispatchSemaphore(value: 0)
    var authorized = false
    var errorMessage: String?

    center.getNotificationSettings { settings in
        switch settings.authorizationStatus {
        case .authorized, .provisional:
            authorized = true
            sem.signal()
        case .notDetermined:
            center.requestAuthorization(options: [.alert, .sound]) { granted, err in
                authorized = granted
                if let err = err {
                    errorMessage = err.localizedDescription
                }
                sem.signal()
            }
        case .denied:
            errorMessage = "notification permission denied by user"
            sem.signal()
        @unknown default:
            errorMessage = "unknown notification authorization status"
            sem.signal()
        }
    }

    sem.wait()

    if !authorized {
        throw HelperError.permissionDenied(errorMessage ?? "notification permission not granted")
    }
}

func schedule(_ req: Request) throws -> [String: Any] {
    guard let id = req.id, !id.isEmpty else {
        throw HelperError.invalidRequest("id is required")
    }
    guard let title = req.title, !title.isEmpty else {
        throw HelperError.invalidRequest("title is required")
    }
    guard let timeIso = req.timeIso else {
        throw HelperError.invalidRequest("timeIso is required")
    }

    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var when = iso.date(from: timeIso)
    if when == nil {
        iso.formatOptions = [.withInternetDateTime]
        when = iso.date(from: timeIso)
    }
    guard let fireDate = when else {
        throw HelperError.invalidRequest("timeIso is not a valid ISO-8601 timestamp")
    }

    try ensureAuthorization()

    let content = UNMutableNotificationContent()
    content.title = title
    if let body = req.body {
        content.body = body
    }
    let soundName = req.sound ?? "default"
    if soundName == "default" {
        content.sound = .defaultCritical
    } else {
        content.sound = UNNotificationSound(named: UNNotificationSoundName(rawValue: soundName))
    }

    let comps = Calendar.current.dateComponents(
        [.year, .month, .day, .hour, .minute, .second],
        from: fireDate
    )
    let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
    let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)

    let center = UNUserNotificationCenter.current()
    let sem = DispatchSemaphore(value: 0)
    var addError: String?
    center.add(request) { err in
        if let err = err {
            addError = err.localizedDescription
        }
        sem.signal()
    }
    sem.wait()

    if let err = addError {
        throw HelperError.scheduleFailed(err)
    }

    return [
        "success": true,
        "id": id,
        "fireAt": ISO8601DateFormatter().string(from: fireDate),
    ]
}

func cancel(_ req: Request) throws -> [String: Any] {
    guard let id = req.id, !id.isEmpty else {
        throw HelperError.invalidRequest("id is required")
    }
    UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [id])
    return ["success": true, "id": id, "cancelled": true]
}

func list() -> [String: Any] {
    let center = UNUserNotificationCenter.current()
    let sem = DispatchSemaphore(value: 0)
    var items: [[String: Any]] = []
    center.getPendingNotificationRequests { requests in
        for req in requests {
            var entry: [String: Any] = [
                "id": req.identifier,
                "title": req.content.title,
                "body": req.content.body,
            ]
            if let cal = req.trigger as? UNCalendarNotificationTrigger,
               let next = cal.nextTriggerDate() {
                entry["fireAt"] = ISO8601DateFormatter().string(from: next)
            }
            items.append(entry)
        }
        sem.signal()
    }
    sem.wait()
    return ["success": true, "alarms": items]
}

func permission() -> [String: Any] {
    let center = UNUserNotificationCenter.current()
    let sem = DispatchSemaphore(value: 0)
    var status = "unknown"
    center.getNotificationSettings { settings in
        switch settings.authorizationStatus {
        case .authorized: status = "authorized"
        case .provisional: status = "provisional"
        case .denied: status = "denied"
        case .notDetermined: status = "not-determined"
        case .ephemeral: status = "ephemeral"
        @unknown default: status = "unknown"
        }
        sem.signal()
    }
    sem.wait()
    return ["success": true, "status": status]
}

do {
    let req = try readRequest()
    switch req.action {
    case "schedule":
        writeJSON(try schedule(req))
    case "cancel":
        writeJSON(try cancel(req))
    case "list":
        writeJSON(list())
    case "permission":
        writeJSON(permission())
    default:
        writeError("unknown action: \(req.action)")
        exit(2)
    }
} catch HelperError.invalidRequest(let msg) {
    log("invalid request: \(msg)")
    writeError("invalid-request: \(msg)")
    exit(2)
} catch HelperError.permissionDenied(let msg) {
    log("permission denied: \(msg)")
    writeError("permission-denied: \(msg)")
    exit(3)
} catch HelperError.scheduleFailed(let msg) {
    log("schedule failed: \(msg)")
    writeError("schedule-failed: \(msg)")
    exit(4)
} catch {
    log("unexpected error: \(error.localizedDescription)")
    writeError("unexpected: \(error.localizedDescription)")
    exit(1)
}
