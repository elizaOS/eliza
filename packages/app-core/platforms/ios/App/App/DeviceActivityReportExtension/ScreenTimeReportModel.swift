/**
 * Reduces and formats private Screen Time aggregates without depending on
 * DeviceActivity, so the report behavior can be executed in native tests.
 */
import Foundation

struct ScreenTimeCategoryDuration: Equatable, Identifiable {
    let name: String
    let duration: TimeInterval

    var id: String { name }
}

enum ScreenTimeReportModel {
    static func topCategories(
        from durationsByCategory: [String: TimeInterval],
        limit: Int = 5
    ) -> [ScreenTimeCategoryDuration] {
        durationsByCategory
            .filter { $0.value > 0 }
            .map { ScreenTimeCategoryDuration(name: $0.key, duration: $0.value) }
            .sorted {
                if $0.duration != $1.duration { return $0.duration > $1.duration }
                return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
            .prefix(max(limit, 0))
            .map { $0 }
    }

    static func formatDuration(
        _ duration: TimeInterval,
        locale: Locale,
        lessThanMinute: String
    ) -> String {
        guard duration >= 60 else { return lessThanMinute }

        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = duration >= 3_600 ? [.hour, .minute] : [.minute]
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 2
        formatter.zeroFormattingBehavior = .dropAll
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = locale
        formatter.calendar = calendar
        return formatter.string(from: duration) ?? lessThanMinute
    }
}
