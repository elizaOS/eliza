/** Exercises the identity predicate used by the native bridge with independent mismatches. */

import Foundation
@testable import BrowserSurfaceLifecycleContract

let identity = NativeBrowserOwnerIdentity(owner: "browser", session: "current", epoch: 2)
let cases = [
    ("browser", "current", 2, true),
    ("other", "current", 2, false),
    ("browser", "other", 2, false),
    ("browser", "current", 1, false),
]
for (owner, session, epoch, expected) in cases {
    let actual = NativeBrowserSurfaceLifecycleContract.owns(
        owner: owner, session: session, epoch: epoch, identity: identity
    )
    guard actual == expected else {
        fatalError("Incorrect ownership for owner=\(owner), session=\(session), epoch=\(epoch)")
    }
}
print("BrowserSurfaceLifecycleContractProbe: \(cases.count) identity cases passed")

let layers: [(Any?, NativeBrowserSurfaceLayer)] = [
    (nil, .aboveHost),
    (NSNull(), .aboveHost),
    ("above-host", .aboveHost),
    ("below-host", .unsupported),
    ("below", .invalid),
    ("", .invalid),
    (true, .invalid),
    (1, .invalid),
]
for (value, expected) in layers {
    guard NativeBrowserSurfaceLayer.parse(value) == expected else {
        fatalError("Incorrect layer for \(String(describing: value))")
    }
}
print("BrowserSurfaceLifecycleContractProbe: \(layers.count) layer cases passed")
