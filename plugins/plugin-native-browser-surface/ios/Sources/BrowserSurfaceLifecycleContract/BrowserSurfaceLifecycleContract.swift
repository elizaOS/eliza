/**
 * Platform-neutral owner filtering and presentation state for iOS Browser
 * surfaces. The Capacitor plugin consumes the same identity predicate while
 * XCTest executes get/list/selected/host transitions without a WebView host.
 */

struct NativeBrowserOwnerIdentity: Equatable {
    let owner: String
    let session: String
    let epoch: Int
}

struct NativeBrowserSurfaceSnapshot: Equatable {
    let id: String
    let owner: String
    let session: String
    let epoch: Int
    var foregrounded: Bool
}

enum NativeBrowserSurfaceLifecycleError: Error, Equatable {
    case missingOwnedSurface(String)
}

enum NativeBrowserSurfaceLifecycleContract {
    static func owns(
        owner: String,
        session: String,
        epoch: Int,
        identity: NativeBrowserOwnerIdentity
    ) -> Bool {
        owner == identity.owner && session == identity.session && epoch == identity.epoch
    }

    static func get(
        id: String,
        from surfaces: [NativeBrowserSurfaceSnapshot],
        identity: NativeBrowserOwnerIdentity
    ) -> NativeBrowserSurfaceSnapshot? {
        surfaces.first {
            $0.id == id && owns(
                owner: $0.owner,
                session: $0.session,
                epoch: $0.epoch,
                identity: identity
            )
        }
    }

    static func list(
        _ surfaces: [NativeBrowserSurfaceSnapshot],
        identity: NativeBrowserOwnerIdentity
    ) -> [NativeBrowserSurfaceSnapshot] {
        surfaces.filter {
            owns(
                owner: $0.owner,
                session: $0.session,
                epoch: $0.epoch,
                identity: identity
            )
        }
    }

    static func present(
        id: String?,
        in surfaces: inout [NativeBrowserSurfaceSnapshot],
        identity: NativeBrowserOwnerIdentity
    ) throws {
        for index in surfaces.indices where surfaces[index].owner == identity.owner {
            surfaces[index].foregrounded = false
        }
        guard let id else { return }
        guard let selected = surfaces.firstIndex(where: {
            $0.id == id && owns(
                owner: $0.owner,
                session: $0.session,
                epoch: $0.epoch,
                identity: identity
            )
        }) else {
            throw NativeBrowserSurfaceLifecycleError.missingOwnedSurface(id)
        }
        surfaces[selected].foregrounded = true
    }
}
