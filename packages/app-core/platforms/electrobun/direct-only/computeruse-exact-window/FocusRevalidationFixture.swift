// SPDX-License-Identifier: MIT
/** Proves a same-bounds control replacement on focus cannot post an event. */

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
        let approved = FixtureElement(
            role: "AXButton",
            label: "Harmless A",
            bounds: ExperimentalRect(x: 40, y: 50, width: 120, height: 30)
        )
        var current = approved
        var postedEvents = 0
        let recipe = [
            ExperimentalEventStep(
                kind: .down,
                pointKind: .target,
                clickState: 1,
                phase: 3,
                deltaX: 0,
                deltaY: 0,
                delayMicroseconds: 0
            ),
        ]
        do {
            try experimentalDispatchSequence(
                recipe: recipe,
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
}
