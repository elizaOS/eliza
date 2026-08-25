// SPDX-License-Identifier: MIT
/** Proves focus-time identity swaps refuse and mutable post-down changes cannot strand a button. */

import Darwin
import Foundation

private struct FixtureElement: Equatable {
    let role: String
    let label: String
    let bounds: ExperimentalRect
}

@main
struct FocusRevalidationFixture {
    static func main() {
        verifyFocusReplacementRefusesBeforePost()
        verifyMutableChangeAfterDownStillPostsRelease()
    }

    private static func matchedClickPair() -> [ExperimentalEventStep] {
        [
            ExperimentalEventStep(
                kind: .down,
                pointKind: .target,
                clickState: 1,
                phase: 3,
                deltaX: 0,
                deltaY: 0,
                delayMicroseconds: 0
            ),
            ExperimentalEventStep(
                kind: .up,
                pointKind: .target,
                clickState: 1,
                phase: 3,
                deltaX: 0,
                deltaY: 0,
                delayMicroseconds: 0
            ),
        ]
    }

    private static func verifyFocusReplacementRefusesBeforePost() {
        let approved = FixtureElement(
            role: "AXButton",
            label: "Harmless A",
            bounds: ExperimentalRect(x: 40, y: 50, width: 120, height: 30)
        )
        var current = approved
        var postedEvents = 0
        do {
            try experimentalDispatchSequence(
                recipe: matchedClickPair(),
                beginFocus: {
                    current = FixtureElement(
                        role: "AXButton",
                        label: "Destructive B",
                        bounds: approved.bounds
                    )
                    return ()
                },
                revalidate: {
                    guard current == approved else {
                        throw ExperimentalExactWindowError.refused(
                            "focus replaced the approved control"
                        )
                    }
                },
                post: { _ in postedEvents += 1 },
                endFocus: { _ in }
            )
            exit(2)
        } catch {
            guard postedEvents == 0 else { exit(3) }
            print("focus-revalidation-refused-before-post")
        }
    }

    private static func verifyMutableChangeAfterDownStillPostsRelease() {
        var focused = false
        var postedKinds: [ExperimentalEventStep.Kind] = []
        do {
            try experimentalDispatchSequence(
                recipe: matchedClickPair(),
                beginFocus: { () },
                revalidate: {
                    guard !focused else {
                        throw ExperimentalExactWindowError.refused(
                            "mutable fingerprint changed after pointer down"
                        )
                    }
                },
                post: { step in
                    postedKinds.append(step.kind)
                    if step.kind == .down { focused = true }
                },
                endFocus: { _ in }
            )
        } catch {
            exit(4)
        }
        guard postedKinds == [.down, .up] else { exit(5) }
        print("mutable-change-after-down-posted-matched-up")
    }
}
