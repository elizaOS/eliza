/**
 * Runs host-side behavioral checks for the fresh-install AppUITest helper.
 * These tests exercise dialog-present and dialog-absent paths without an app,
 * Simulator, production preference, or injected product callback.
 */

private func expect(
    _ condition: @autoclosure () -> Bool,
    _ message: String
) {
    guard condition() else {
        fatalError(message)
    }
}

private func testDialogAbsentDoesNothing() {
    var tapCount = 0
    var waitCount = 0
    let result = driveFreshInstallPermissionOnboarding(
        dialogIsPresent: { false },
        skipIsHittable: { true },
        tapSkip: { tapCount += 1 },
        waitForNextPoll: { waitCount += 1 }
    )

    expect(result == .absent, "an absent dialog must report absent")
    expect(tapCount == 0, "an absent dialog must not tap another control")
    expect(waitCount == 0, "an absent dialog must not delay renderer readiness")
}

private func testDialogPresentUsesSkipAndWaitsForDismissal() {
    var dialogPresent = true
    var skipTapped = false
    var tapCount = 0
    var waitCount = 0
    let result = driveFreshInstallPermissionOnboarding(
        dialogIsPresent: { dialogPresent },
        skipIsHittable: { true },
        tapSkip: {
            tapCount += 1
            skipTapped = true
        },
        waitForNextPoll: {
            waitCount += 1
            if skipTapped { dialogPresent = false }
        }
    )

    expect(result == .skipped, "a dismissed dialog must report skipped")
    expect(tapCount == 1, "the genuine Skip control must be tapped exactly once")
    expect(waitCount == 1, "the helper must wait for asynchronous dismissal")
}

testDialogAbsentDoesNothing()
testDialogPresentUsesSkipAndWaitsForDismissal()
print("fresh-install AppUITest helper: 2/2 PASS")
