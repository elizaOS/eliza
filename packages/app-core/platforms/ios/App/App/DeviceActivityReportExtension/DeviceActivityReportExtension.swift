import DeviceActivity
import SwiftUI

@main
struct ElizaDeviceActivityReportExtension: DeviceActivityReportExtension {
    var body: some DeviceActivityReportScene {
        ElizaDeviceActivityReportScene { configuration in
            ElizaDeviceActivityReportView(configuration: configuration)
        }
    }
}

private struct ElizaDeviceActivityReportConfiguration {
    let title: String
    let message: String
}

private struct ElizaDeviceActivityReportScene: DeviceActivityReportScene {
    let context: DeviceActivityReport.Context = .elizaScreenTimeSummary
    let content: (ElizaDeviceActivityReportConfiguration) -> ElizaDeviceActivityReportView

    func makeConfiguration(
        representing data: DeviceActivityResults<DeviceActivityData>
    ) async -> ElizaDeviceActivityReportConfiguration {
        _ = data
        return ElizaDeviceActivityReportConfiguration(
            title: "Screen Time",
            message: "Screen Time activity is available for this report."
        )
    }
}

private struct ElizaDeviceActivityReportView: View {
    let configuration: ElizaDeviceActivityReportConfiguration

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(configuration.title)
                .font(.headline)
            Text(configuration.message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

private extension DeviceActivityReport.Context {
    static let elizaScreenTimeSummary = Self("eliza.screen-time.summary")
}
