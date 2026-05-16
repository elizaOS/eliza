import ElizaMacCore
import SwiftUI

struct SidebarView: View {
    let sections: [AppSection]
    @Binding var selection: AppSection?

    var body: some View {
        List(selection: $selection) {
            Section("Eliza") {
                ForEach(sections) { section in
                    HStack(spacing: 10) {
                        Image(systemName: section.systemImage)
                            .foregroundStyle(.secondary)
                            .frame(width: 16)

                        VStack(alignment: .leading, spacing: 2) {
                            Text(section.title)
                                .lineLimit(1)

                            Text(section.detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    .tag(Optional(section))
                    .contentShape(Rectangle())
                    .onTapGesture {
                        selection = section
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Eliza")
    }
}
