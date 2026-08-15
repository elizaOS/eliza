/**
 * Renders authorized Screen Time activity entirely inside Apple's report
 * extension sandbox. No activity values cross into the host app or network.
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
    let categories: [ScreenTimeCategoryDuration]
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
                    let name = categoryActivity.category.localizedDisplayName?
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    let displayName = name.flatMap { $0.isEmpty ? nil : $0 }
                        ?? String(localized: "Other")
                    durationsByCategory[displayName, default: 0] +=
                        categoryActivity.totalActivityDuration
                }
            }
        }

        return ElizaDeviceActivityReportConfiguration(
            totalDuration: totalDuration,
            categories: ScreenTimeReportModel.topCategories(from: durationsByCategory)
        )
    }
}

@available(iOS 16.0, *)
private struct ElizaDeviceActivityReportView: View {
    let configuration: ElizaDeviceActivityReportConfiguration

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Screen Time")
                .font(.headline)
                .accessibilityAddTraits(.isHeader)

            if configuration.totalDuration > 0 {
                Text(Self.format(configuration.totalDuration))
                    .font(.title2.weight(.semibold))
                    .accessibilityLabel(
                        String(
                            format: String(localized: "Total activity: %@"),
                            Self.format(configuration.totalDuration)
                        )
                    )

                if !configuration.categories.isEmpty {
                    Text("Top categories")
                        .font(.subheadline.weight(.semibold))
                        .accessibilityAddTraits(.isHeader)
                    ForEach(configuration.categories) { category in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(category.name)
                                    .lineLimit(1)
                                Spacer()
                                Text(Self.format(category.duration))
                                    .foregroundStyle(.secondary)
                            }
                            ProgressView(
                                value: category.duration,
                                total: max(configuration.totalDuration, 1)
                            )
                            .tint(.orange)
                        }
                        .accessibilityElement(children: .combine)
                    }
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
        ScreenTimeReportModel.formatDuration(
            duration,
            locale: .current,
            lessThanMinute: String(localized: "Less than a minute")
        )
    }
}

@available(iOS 16.0, *)
private extension DeviceActivityReport.Context {
    static let elizaScreenTimeSummary = Self("eliza.screen-time.summary")
}
