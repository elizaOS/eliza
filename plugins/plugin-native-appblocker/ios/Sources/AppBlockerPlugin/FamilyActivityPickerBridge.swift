import FamilyControls
import ManagedSettings
import SwiftUI
import UIKit

@MainActor
enum FamilyActivityPickerBridge {
    static func present(
        from viewController: UIViewController,
        completion: @escaping ([ManagedSettings.ApplicationToken], Bool) -> Void
    ) {
        let pickerController = UIHostingController(
            rootView: PickerWrapper(completion: completion)
        )
        pickerController.modalPresentationStyle = UIModalPresentationStyle.formSheet
        viewController.present(pickerController, animated: true)
    }
}

private struct PickerWrapper: View {
    @Environment(\.dismiss) private var dismiss
    @State private var selection = FamilyActivitySelection()

    let completion: ([ManagedSettings.ApplicationToken], Bool) -> Void

    var body: some View {
        NavigationView {
            FamilyActivityPicker(selection: $selection)
                .navigationTitle("Select Apps")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            completion([], true)
                            dismiss()
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            completion(Array(selection.applicationTokens), false)
                            dismiss()
                        }
                    }
                }
        }
        .navigationViewStyle(StackNavigationViewStyle())
    }
}
