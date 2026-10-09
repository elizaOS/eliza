/**
 * Aggregates authorized Screen Time activity entirely inside Apple's report
 * extension sandbox for the host-presented privacy-preserving report.
 */
import DeviceActivity
import Foundation
import SwiftUI

@main
@available(iOS 16.0, *)
struct ElizaDeviceActivityReportExtension: DeviceActivityReportExtension {
    var body: some DeviceActivityReportScene {
        ElizaDeviceActivityReportScene { configuration in
            ElizaDeviceActivityReportView(configuration: configuration)
        }
    }
}

private struct ElizaDeviceActivityReportConfiguration {
    let totalDuration: TimeInterval
    let categories: [ElizaScreenTimeCategory]
}

private struct ElizaScreenTimeCategory: Identifiable {
    let name: String
    let duration: TimeInterval

    var id: String { name }
}

@available(iOS 16.0, *)
private struct ElizaDeviceActivityReportScene: DeviceActivityReportScene {
    let context: DeviceActivityReport.Context = .elizaScreenTimeSummary
    let content: (ElizaDeviceActivityReportConfiguration) -> ElizaDeviceActivityReportView

    func makeConfiguration(
        representing data: DeviceActivityResults<DeviceActivityData>
    ) async -> ElizaDeviceActivityReportConfiguration {
        var totalDuration: TimeInterval = 0
        var durationsByCategory: [String: TimeInterval] = [:]

        for await deviceActivity in data {
            for await segment in deviceActivity.activitySegments {
                totalDuration += segment.totalActivityDuration
                for await categoryActivity in segment.categories {
                    guard categoryActivity.totalActivityDuration > 0 else { continue }
                    let localizedName = categoryActivity.category.localizedDisplayName?
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    let name = localizedName.flatMap { $0.isEmpty ? nil : $0 } ?? "Other"
                    durationsByCategory[name, default: 0] += categoryActivity.totalActivityDuration
                }
            }
        }

        let categories = durationsByCategory
            .map { ElizaScreenTimeCategory(name: $0.key, duration: $0.value) }
            .sorted {
                if $0.duration != $1.duration { return $0.duration > $1.duration }
                return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
            .prefix(5)

        return ElizaDeviceActivityReportConfiguration(
            totalDuration: totalDuration,
            categories: Array(categories)
        )
    }
}

private struct ElizaDeviceActivityReportView: View {
    let configuration: ElizaDeviceActivityReportConfiguration

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Screen Time")
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            if configuration.totalDuration > 0 {
                Text(Self.format(configuration.totalDuration))
                    .font(.title2.weight(.semibold))
                ForEach(configuration.categories) { category in
                    HStack {
                        Text(category.name).lineLimit(1)
                        Spacer()
                        Text(Self.format(category.duration)).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            } else {
                Text("No Screen Time activity is available for this period.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
    }

    private static func format(_ duration: TimeInterval) -> String {
        guard duration >= 60 else { return "Less than a minute" }
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = duration >= 3_600 ? [.hour, .minute] : [.minute]
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 2
        return formatter.string(from: duration) ?? "Less than a minute"
    }
}

@available(iOS 16.0, *)
private extension DeviceActivityReport.Context {
    static let elizaScreenTimeSummary = Self("eliza.screen-time.summary")
}
