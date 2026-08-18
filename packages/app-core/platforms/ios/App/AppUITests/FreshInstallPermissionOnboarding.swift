/**
 * Drives the fresh-install permissions dialog through its public UI controls.
 * The pure closure boundary keeps present and absent behavior testable without
 * launching an app or mutating production preferences.
 */

enum FreshInstallPermissionOnboardingResult: Equatable {
    case absent
    case skipped
    case blocked
}

@discardableResult
func driveFreshInstallPermissionOnboarding(
    dialogIsPresent: () -> Bool,
    skipIsHittable: () -> Bool,
    tapSkip: () -> Void,
    waitForNextPoll: () -> Void,
    maxPolls: Int = 10
) -> FreshInstallPermissionOnboardingResult {
    guard dialogIsPresent() else { return .absent }

    let pollCount = max(1, maxPolls)
    for _ in 0..<pollCount {
        if !dialogIsPresent() { return .skipped }
        if skipIsHittable() {
            tapSkip()
            for _ in 0..<pollCount {
                if !dialogIsPresent() { return .skipped }
                waitForNextPoll()
            }
            return .blocked
        }
        waitForNextPoll()
    }

    return .blocked
}

/// Reconciles the same dialog after renderer readiness. The renderer probe can
/// become visible one animation frame before the native-hosted web dialog
/// mounts, so an immediate `.absent` result is not authoritative while the
/// expected interaction surface is also absent.
@discardableResult
func driveFreshInstallPermissionOnboardingAfterRendererReady(
    dialogIsPresent: () -> Bool,
    skipIsHittable: () -> Bool,
    interactionIsReady: () -> Bool,
    tapSkip: () -> Void,
    waitForNextPoll: () -> Void,
    maxMountPolls: Int = 20,
    maxDismissPolls: Int = 10
) -> FreshInstallPermissionOnboardingResult {
    if dialogIsPresent() {
        return driveFreshInstallPermissionOnboarding(
            dialogIsPresent: dialogIsPresent,
            skipIsHittable: skipIsHittable,
            tapSkip: tapSkip,
            waitForNextPoll: waitForNextPoll,
            maxPolls: maxDismissPolls
        )
    }

    for _ in 0..<max(1, maxMountPolls) {
        if interactionIsReady() { return .absent }
        waitForNextPoll()
        if dialogIsPresent() {
            return driveFreshInstallPermissionOnboarding(
                dialogIsPresent: dialogIsPresent,
                skipIsHittable: skipIsHittable,
                tapSkip: tapSkip,
                waitForNextPoll: waitForNextPoll,
                maxPolls: maxDismissPolls
            )
        }
    }

    return .absent
}
