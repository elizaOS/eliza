// SPDX-License-Identifier: MIT
/** Defines the deterministic request, validation, and event-recipe contract for the direct-only helper. */

import CoreGraphics
import Darwin
import Foundation

struct ExperimentalPoint: Codable, Equatable {
    let x: Double
    let y: Double

    var cgPoint: CGPoint { CGPoint(x: x, y: y) }
    var isFinite: Bool { x.isFinite && y.isFinite }
}

struct ExperimentalRect: Codable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var cgRect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
    var isFiniteAndPositive: Bool {
        x.isFinite && y.isFinite && width.isFinite && height.isFinite && width > 0 && height > 0
    }
}

func experimentalPointDictionary(_ point: CGPoint) -> [String: Double] {
    ["x": point.x, "y": point.y]
}

func experimentalRectDictionary(_ rect: CGRect) -> [String: Double] {
    [
        "x": rect.origin.x,
        "y": rect.origin.y,
        "width": rect.size.width,
        "height": rect.size.height,
    ]
}

func experimentalDispatchResultDictionary(
    observationId: String,
    targetPid: pid_t,
    targetWindowId: CGWindowID,
    targetWindowBounds: CGRect,
    pointerBefore: CGPoint,
    pointerAfter: CGPoint
) -> [String: Any] {
    [
        "success": true,
        "route": "experimental_direct_exact_window",
        "observationId": observationId,
        "targetPid": targetPid,
        "targetWindowId": targetWindowId,
        "targetWindowBounds": experimentalRectDictionary(targetWindowBounds),
        "pointerBefore": experimentalPointDictionary(pointerBefore),
        "pointerAfter": experimentalPointDictionary(pointerAfter),
    ]
}

struct ExperimentalElementFingerprint: Decodable {
    let locator: [Int]
    let role: String
    let subrole: String?
    let label: String?
    let value: String?
    let elementDescription: String?
    let bounds: ExperimentalRect
    let actions: [String]
    let enabled: Bool
    let focused: Bool
    let selected: Bool?
    let secure: Bool

    enum CodingKeys: String, CodingKey {
        case locator
        case role
        case subrole
        case label
        case value
        case elementDescription = "description"
        case bounds
        case actions
        case enabled
        case focused
        case selected
        case secure
    }
}

struct ExperimentalRequest: Decodable {
    let command: String
    let experimental: Bool?
    let route: String?
    let observationId: String?
    let action: String?
    let pid: Int32?
    let windowId: UInt32?
    let windowPoint: ExperimentalPoint?
    let screenPoint: ExperimentalPoint?
    let expectedWindowBounds: ExperimentalRect?
    let expectedElement: ExperimentalElementFingerprint?
    let direction: String?
    let amount: Int?
}

struct ExperimentalEventStep: Equatable {
    enum Kind: String {
        case moved
        case down
        case up
        case scroll
    }

    enum PointKind: String {
        case target
        case primer
    }

    let kind: Kind
    let pointKind: PointKind
    let clickState: Int64
    let phase: Int64
    let deltaX: Int32
    let deltaY: Int32
    let delayMicroseconds: useconds_t

    var dictionary: [String: Any] {
        [
            "kind": kind.rawValue,
            "pointKind": pointKind.rawValue,
            "clickState": clickState,
            "phase": phase,
            "deltaX": deltaX,
            "deltaY": deltaY,
            "delayMicroseconds": delayMicroseconds,
        ]
    }
}

enum ExperimentalExactWindowError: Error, LocalizedError {
    case refused(String)

    var errorDescription: String? {
        switch self {
        case let .refused(message): message
        }
    }
}

func experimentalEventRecipe(
    action: String,
    direction: String?,
    amount: Int?
) throws -> [ExperimentalEventStep] {
    if action == "click" {
        return [
            ExperimentalEventStep(kind: .moved, pointKind: .target, clickState: 0, phase: 2, deltaX: 0, deltaY: 0, delayMicroseconds: 15_000),
            ExperimentalEventStep(kind: .down, pointKind: .primer, clickState: 1, phase: 1, deltaX: 0, deltaY: 0, delayMicroseconds: 1_000),
            ExperimentalEventStep(kind: .up, pointKind: .primer, clickState: 1, phase: 2, deltaX: 0, deltaY: 0, delayMicroseconds: 100_000),
            ExperimentalEventStep(kind: .down, pointKind: .target, clickState: 1, phase: 3, deltaX: 0, deltaY: 0, delayMicroseconds: 1_000),
            ExperimentalEventStep(kind: .up, pointKind: .target, clickState: 1, phase: 3, deltaX: 0, deltaY: 0, delayMicroseconds: 0),
        ]
    }
    guard action == "scroll" else {
        throw ExperimentalExactWindowError.refused("Only click and scroll are supported")
    }
    let magnitude = Int32(max(1, min(amount ?? 3, 20)) * 40)
    let delta: (Int32, Int32)
    switch direction ?? "down" {
    case "up": delta = (0, magnitude)
    case "down": delta = (0, -magnitude)
    case "left": delta = (magnitude, 0)
    case "right": delta = (-magnitude, 0)
    default:
        throw ExperimentalExactWindowError.refused("Invalid scroll direction")
    }
    return [
        ExperimentalEventStep(kind: .scroll, pointKind: .target, clickState: 0, phase: 2, deltaX: delta.0, deltaY: delta.1, delayMicroseconds: 0),
    ]
}

func experimentalBoundsMatch(_ left: CGRect, _ right: CGRect, tolerance: CGFloat = 1) -> Bool {
    abs(left.origin.x - right.origin.x) <= tolerance &&
        abs(left.origin.y - right.origin.y) <= tolerance &&
        abs(left.size.width - right.size.width) <= tolerance &&
        abs(left.size.height - right.size.height) <= tolerance
}

private func experimentalDispatchUnits(
    recipe: [ExperimentalEventStep]
) throws -> [[ExperimentalEventStep]] {
    var units: [[ExperimentalEventStep]] = []
    var index = 0
    while index < recipe.count {
        let step = recipe[index]
        switch step.kind {
        case .down:
            guard index + 1 < recipe.count else {
                throw ExperimentalExactWindowError.refused(
                    "A pointer-down recipe must include an immediate pointer-up"
                )
            }
            let release = recipe[index + 1]
            guard release.kind == .up,
                  release.pointKind == step.pointKind,
                  release.clickState == step.clickState
            else {
                throw ExperimentalExactWindowError.refused(
                    "Pointer-down and pointer-up must form one matched dispatch unit"
                )
            }
            units.append([step, release])
            index += 2
        case .up:
            throw ExperimentalExactWindowError.refused(
                "A standalone pointer-up recipe is invalid"
            )
        case .moved, .scroll:
            units.append([step])
            index += 1
        }
    }
    return units
}

func experimentalDispatchSequence<FocusContext>(
    recipe: [ExperimentalEventStep],
    beginFocus: () throws -> FocusContext,
    revalidate: () throws -> Void,
    post: (ExperimentalEventStep) -> Void,
    endFocus: (FocusContext) throws -> Void
) throws {
    let units = try experimentalDispatchUnits(recipe: recipe)
    let focusContext = try beginFocus()
    do {
        // Synthetic focus is an observable UI transition. The captured AX
        // identity must still be authoritative after it and at each safe
        // dispatch boundary. A matched down/up unit has no throwing or
        // revalidation boundary that could strand the primary button down.
        try revalidate()
        for unit in units {
            try revalidate()
            for step in unit {
                post(step)
            }
        }
        try endFocus(focusContext)
    } catch {
        // error-policy:J6 best-effort synthetic-focus teardown before rethrow.
        try? endFocus(focusContext)
        throw error
    }
}
