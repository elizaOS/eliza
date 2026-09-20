/** Matches the owner, renderer session and epoch used by native browser bridge reads and mutations. */

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
