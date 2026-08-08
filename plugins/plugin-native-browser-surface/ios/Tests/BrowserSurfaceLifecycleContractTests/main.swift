/** Executes iOS Browser identity reads and atomic presentation without mocks. */

@testable import BrowserSurfaceLifecycleContract

private func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fatalError(message) }
}

private let current = NativeBrowserOwnerIdentity(
    owner: "browser",
    session: "realm-current",
    epoch: 2
)

private func surfaces() -> [NativeBrowserSurfaceSnapshot] {
    [
        NativeBrowserSurfaceSnapshot(
            id: "a",
            owner: "browser",
            session: "realm-current",
            epoch: 2,
            foregrounded: true
        ),
        NativeBrowserSurfaceSnapshot(
            id: "b",
            owner: "browser",
            session: "realm-current",
            epoch: 2,
            foregrounded: false
        ),
        NativeBrowserSurfaceSnapshot(
            id: "retired",
            owner: "browser",
            session: "realm-old",
            epoch: 1,
            foregrounded: true
        ),
        NativeBrowserSurfaceSnapshot(
            id: "other-owner",
            owner: "other",
            session: "realm-other",
            epoch: 1,
            foregrounded: true
        ),
    ]
}

let readState = surfaces()
require(
    NativeBrowserSurfaceLifecycleContract.get(
        id: "a",
        from: readState,
        identity: current
    )?.id == "a",
    "get must expose an active-owner surface"
)
require(
    NativeBrowserSurfaceLifecycleContract.get(
        id: "retired",
        from: readState,
        identity: current
    ) == nil,
    "get must fence a retired renderer epoch"
)
require(
    NativeBrowserSurfaceLifecycleContract.list(readState, identity: current).map(\.id) ==
        ["a", "b"],
    "list must expose only the active renderer identity"
)

var selectedState = surfaces()
try NativeBrowserSurfaceLifecycleContract.present(
    id: "b",
    in: &selectedState,
    identity: current
)
require(
    selectedState.first { $0.id == "a" }?.foregrounded == false,
    "presentation must hide the previous sibling"
)
require(
    selectedState.first { $0.id == "b" }?.foregrounded == true,
    "presentation must show exactly the selected surface"
)
require(
    selectedState.first { $0.id == "retired" }?.foregrounded == false,
    "presentation must hide every stable-owner generation"
)
require(
    selectedState.first { $0.id == "other-owner" }?.foregrounded == true,
    "presentation must not mutate another owner"
)

var hostState = surfaces()
try NativeBrowserSurfaceLifecycleContract.present(
    id: nil,
    in: &hostState,
    identity: current
)
require(
    hostState.filter { $0.owner == current.owner }.allSatisfy { !$0.foregrounded },
    "host presentation must hide every stable-owner surface"
)

var missingState = surfaces()
do {
    try NativeBrowserSurfaceLifecycleContract.present(
        id: "missing",
        in: &missingState,
        identity: current
    )
    fatalError("missing selection must reject")
} catch NativeBrowserSurfaceLifecycleError.missingOwnedSurface("missing") {
    require(
        missingState.filter { $0.owner == current.owner }.allSatisfy { !$0.foregrounded },
        "missing selection must leave the host safe"
    )
}

print("BrowserSurfaceLifecycleContractProbe: 3/3 passed")
