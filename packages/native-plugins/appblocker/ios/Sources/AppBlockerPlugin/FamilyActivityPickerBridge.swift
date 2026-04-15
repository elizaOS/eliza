import UIKit
import SwiftUI
import FamilyControls

/// Bridges the SwiftUI FamilyActivityPicker into UIKit so Capacitor can present it modally.
@available(iOS 16.0, *)
final class FamilyActivityPickerBridge {

    private var hostingController: UIHostingController<PickerWrapper>?
    private var completion: (([String], Bool) -> Void)?

    /// Present the FamilyActivityPicker modally from the given view controller.
    /// On completion, calls back with (tokenDataArray, cancelled).
    func present(from viewController: UIViewController, completion: @escaping ([String], Bool) -> Void) {
        self.completion = completion

        let wrapper = PickerWrapper { [weak self] selection, cancelled in
            self?.hostingController?.dismiss(animated: true) {
                if cancelled {
                    self?.completion?([], true)
                } else {
                    let tokenData = AppBlockerShared.serializeSelection(selection)
                    self?.completion?(tokenData, false)
                }
                self?.hostingController = nil
                self?.completion = nil
            }
        }

        let hosting = UIHostingController(rootView: wrapper)
        hosting.modalPresentationStyle = .pageSheet
        self.hostingController = hosting
        viewController.present(hosting, animated: true)
    }
}

/// SwiftUI wrapper around FamilyActivityPicker with Done/Cancel buttons.
@available(iOS 16.0, *)
private struct PickerWrapper: View {
    @State private var selection = FamilyActivitySelection()
    let onFinish: (FamilyActivitySelection, Bool) -> Void

    var body: some View {
        NavigationView {
            FamilyActivityPicker(selection: $selection)
                .navigationTitle("Select Apps to Block")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            onFinish(selection, true)
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            onFinish(selection, false)
                        }
                    }
                }
        }
    }
}
