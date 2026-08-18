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
