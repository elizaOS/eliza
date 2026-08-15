import DeviceActivity
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
    let title: String
    let categorySummaries: [CategorySummary]
    
    struct CategorySummary {
        let name: String
        let totalActivityDuration: TimeInterval
    }
}

@available(iOS 16.0, *)
private struct ElizaDeviceActivityReportScene: DeviceActivityReportScene {
    let context: DeviceActivityReport.Context = .elizaScreenTimeSummary
    let content: (ElizaDeviceActivityReportConfiguration) -> ElizaDeviceActivityReportView

    func makeConfiguration(
        representing data: DeviceActivityResults<DeviceActivityData>
    ) async -> ElizaDeviceActivityReportConfiguration {
        var categorySummaries: [ElizaDeviceActivityReportConfiguration.CategorySummary] = []
        
        for await result in data {
            if let category = result.category {
                let totalDuration = result.totalActivityDuration
                categorySummaries.append(CategorySummary(
                    name: category.rawValue,
                    totalActivityDuration: totalDuration
                ))
            }
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
        let hours = Int(duration) / 3600
        let minutes = (Int(duration) % 3600) / 60
        
        if hours > 0 {
            return "\(hours)h \(minutes)m"
        } else {
            return "\(minutes)m"
        }
    }
}

@available(iOS 16.0, *)
private extension DeviceActivityReport.Context {
    static let elizaScreenTimeSummary = Self("eliza.screen-time.summary")
}
