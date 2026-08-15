/**
 * Renders privacy-sandboxed DeviceActivity category totals inside the iOS report extension.
 *
 * Activity data is consumed and rendered in the extension process and must never be exported
 * to the host application.
 */
import DeviceActivity
import Foundation
import ManagedSettings
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
    struct CategorySummary {
        let name: String
        let totalActivityDuration: TimeInterval
    }

    let title: String
    let categorySummaries: [CategorySummary]
}

@available(iOS 16.0, *)
private struct ElizaDeviceActivityReportScene: DeviceActivityReportScene {
    let context: DeviceActivityReport.Context = .elizaScreenTimeSummary
    let content: (ElizaDeviceActivityReportConfiguration) -> ElizaDeviceActivityReportView

    func makeConfiguration(
        representing data: DeviceActivityResults<DeviceActivityData>
    ) async -> ElizaDeviceActivityReportConfiguration {
        var durationByCategory: [String: TimeInterval] = [:]

        for await activityData in data {
            for await segment in activityData.activitySegments {
                for await categoryActivity in segment.categories {
                    let localizedName = categoryActivity.category.localizedDisplayName?
                        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let name = localizedName.isEmpty ? "Other" : localizedName
                    durationByCategory[name, default: 0] += categoryActivity.totalActivityDuration
                }
            }
        }

        let categorySummaries = durationByCategory
            .map { name, duration in
                ElizaDeviceActivityReportConfiguration.CategorySummary(
                    name: name,
                    totalActivityDuration: duration
                )
            }
            .sorted { left, right in
                if left.totalActivityDuration == right.totalActivityDuration {
                    return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
                }
                return left.totalActivityDuration > right.totalActivityDuration
            }

        return ElizaDeviceActivityReportConfiguration(
            title: "Screen Time Summary",
            categorySummaries: categorySummaries
        )
    }
}

private struct ElizaDeviceActivityReportView: View {
    let configuration: ElizaDeviceActivityReportConfiguration

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(configuration.title)
                .font(.headline)

            if configuration.categorySummaries.isEmpty {
                Text("No activity data available for this period.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(configuration.categorySummaries, id: \.name) { summary in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(summary.name)
                            .font(.subheadline)
                            .fontWeight(.medium)
                        Text(formatDuration(summary.totalActivityDuration))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding()
    }

    private func formatDuration(_ duration: TimeInterval) -> String {
        let wholeSeconds = max(0, Int(duration.rounded(.down)))
        let hours = wholeSeconds / 3600
        let minutes = (wholeSeconds % 3600) / 60

        if hours > 0 {
            return "\(hours)h \(minutes)m"
        }
        return "\(minutes)m"
    }
}

@available(iOS 16.0, *)
private extension DeviceActivityReport.Context {
    static let elizaScreenTimeSummary = Self("eliza.screen-time.summary")
}
