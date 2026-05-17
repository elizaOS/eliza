import ElizaMacCore
import SwiftUI

struct FeatureGrid: View {
    let features: [ShellFeature]
    var actionTitle: String?
    var action: ((ShellFeature) -> Void)?

    private let columns = [
        GridItem(.adaptive(minimum: 280), spacing: 14)
    ]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 14) {
            ForEach(features) { feature in
                FeatureCard(
                    feature: feature,
                    actionTitle: actionTitle,
                    action: action.map { callback in
                        { callback(feature) }
                    }
                )
            }
        }
    }
}
