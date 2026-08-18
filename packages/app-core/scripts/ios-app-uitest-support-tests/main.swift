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

private func testDialogDisappearsBeforeSkipBecomesHittable() {
    var dialogPresent = true
    var tapCount = 0
    var waitCount = 0
    let result = driveFreshInstallPermissionOnboarding(
        dialogIsPresent: { dialogPresent },
        skipIsHittable: { false },
        tapSkip: { tapCount += 1 },
        waitForNextPoll: {
            waitCount += 1
            dialogPresent = false
        }
    )

    expect(
        result == .skipped,
        "a dialog dismissed before Skip becomes hittable must continue readiness"
    )
    expect(tapCount == 0, "a vanished dialog must not tap a stale control")
    expect(waitCount == 1, "the helper must observe the asynchronous dismissal")
}

private func testRendererReadyBeforeDialogMountStillUsesSkip() {
    var dialogPresent = false
    var interactionReady = false
    var skipTapped = false
    var tapCount = 0
    var waitCount = 0
    let result = driveFreshInstallPermissionOnboardingAfterRendererReady(
        dialogIsPresent: { dialogPresent },
        skipIsHittable: { dialogPresent },
        interactionIsReady: { interactionReady },
        tapSkip: {
            tapCount += 1
            skipTapped = true
        },
        waitForNextPoll: {
            waitCount += 1
            if waitCount == 1 { dialogPresent = true }
            if skipTapped {
                dialogPresent = false
                interactionReady = true
            }
        }
    )

    expect(
        result == .skipped,
        "a permission dialog mounted after renderer readiness must still be skipped"
    )
    expect(tapCount == 1, "the late genuine Skip control must be tapped once")
    expect(waitCount == 2, "the helper must observe late mount and dismissal")
}

private func testInteractiveRendererWithoutDialogUsesOneGracePoll() {
    var tapCount = 0
    var waitCount = 0
    let result = driveFreshInstallPermissionOnboardingAfterRendererReady(
        dialogIsPresent: { false },
        skipIsHittable: { false },
        interactionIsReady: { true },
        tapSkip: { tapCount += 1 },
        waitForNextPoll: { waitCount += 1 }
    )

    expect(result == .absent, "an interactive renderer needs no onboarding action")
    expect(tapCount == 0, "an absent late dialog must not tap another control")
    expect(waitCount == 1, "an interactive renderer needs one late-mount grace poll")
}

private func testInteractiveRendererBeforeDialogMountStillUsesSkip() {
    var dialogPresent = false
    var skipTapped = false
    var tapCount = 0
    var waitCount = 0
    let result = driveFreshInstallPermissionOnboardingAfterRendererReady(
        dialogIsPresent: { dialogPresent },
        skipIsHittable: { dialogPresent },
        interactionIsReady: { true },
        tapSkip: {
            tapCount += 1
            skipTapped = true
        },
        waitForNextPoll: {
            waitCount += 1
            if waitCount == 1 { dialogPresent = true }
            if skipTapped { dialogPresent = false }
        }
    )

    expect(
        result == .skipped,
        "a next-poll permission dialog must outrank early renderer interactivity"
    )
    expect(tapCount == 1, "the late genuine Skip control must be tapped once")
    expect(waitCount == 2, "the helper must observe next-poll mount and dismissal")
}

testDialogAbsentDoesNothing()
testDialogPresentUsesSkipAndWaitsForDismissal()
testDialogDisappearsBeforeSkipBecomesHittable()
testRendererReadyBeforeDialogMountStillUsesSkip()
testInteractiveRendererWithoutDialogUsesOneGracePoll()
testInteractiveRendererBeforeDialogMountStillUsesSkip()
print("fresh-install AppUITest helper: 6/6 PASS")
