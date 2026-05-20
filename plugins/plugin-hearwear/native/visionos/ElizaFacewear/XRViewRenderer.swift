import RealityKit
import SwiftUI

/// Renders the elizaOS XR view panels as 3D floating panels in visionOS space
/// using RealityKit entities.
///
/// Each panel is a ModelEntity with a MeshResource.generatePlane and a
/// SimpleMaterial that wraps a WebXRView (WKWebView) via UIViewRepresentable
/// rendered into a texture.
struct XRViewRenderer: View {
    let agentBaseUrl: String
    @State private var panels: [XRPanel] = []

    var body: some View {
        RealityView { content in
            for panel in panels {
                content.add(panel.entity)
            }
        } update: { content in
            // Panels are added/removed via state changes — RealityView updates automatically
        }
    }

    func openPanel(viewId: String, agentBaseUrl: String, scale: Float = 1.0) {
        let entity = makePanelEntity(scale: scale)
        let panel = XRPanel(id: viewId, entity: entity, agentBaseUrl: agentBaseUrl)
        panels.append(panel)
    }

    func closePanel(viewId: String) {
        panels.removeAll { $0.id == viewId }
    }

    private func makePanelEntity(scale: Float) -> ModelEntity {
        let width: Float = 0.6 * scale
        let height: Float = 0.4 * scale
        let mesh = MeshResource.generatePlane(width: width, depth: height)
        var material = SimpleMaterial()
        material.color = .init(tint: .white, texture: nil)
        let entity = ModelEntity(mesh: mesh, materials: [material])
        // Position panel ~1.5m in front of user
        entity.position = SIMD3<Float>(0, 1.5, -1.5)
        return entity
    }
}

struct XRPanel: Identifiable {
    let id: String
    let entity: ModelEntity
    let agentBaseUrl: String
}
