/** Matches the owner, renderer session and epoch used by native browser bridge reads and mutations. */

import Foundation

struct NativeBrowserOwnerIdentity: Equatable {
    let owner: String
    let session: String
    let epoch: Int
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
}

/** The createSurface `layer` option as iOS reads it. */
enum NativeBrowserSurfaceLayer: Equatable {
    case aboveHost
    /** `below-host` is a real layer, but only Android draws it. */
    case unsupported
    case invalid

    /** Absent or null is `above-host`; a value that is not a known name (a typo, a number) is invalid. */
    static func parse(_ value: Any?) -> NativeBrowserSurfaceLayer {
        if value == nil || value is NSNull { return .aboveHost }
        switch value as? String {
        case "above-host": return .aboveHost
        case "below-host": return .unsupported
        default: return .invalid
        }
    }
}
