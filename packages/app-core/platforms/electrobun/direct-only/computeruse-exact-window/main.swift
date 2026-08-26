// SPDX-License-Identifier: MIT
/** Implements the one-request JSON boundary for probe, recipe, and explicit experimental dispatch. */

import CoreGraphics
import Foundation

let routeName = "experimental_direct_exact_window"

func writeResponse(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
}

do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let request = try JSONDecoder().decode(ExperimentalRequest.self, from: input)
    if request.command == "probe" {
        let capability = ExperimentalExactWindowSPI.shared.capability
        writeResponse([
            "ok": true,
            "result": [
                "route": routeName,
                "available": capability.available,
                "minimumMacOSMet": capability.minimumMacOSMet,
                "missingSymbols": capability.missingSymbols,
                "defaultEnabled": false,
            ],
        ])
    } else if request.command == "recipe" {
        let recipe = try experimentalEventRecipe(
            action: request.action ?? "",
            direction: request.direction,
            amount: request.amount
        )
        writeResponse([
            "ok": true,
            "result": ["route": routeName, "steps": recipe.map(\.dictionary)],
        ])
    } else if request.command == "wire-contract" {
        guard let observationId = request.observationId, !observationId.isEmpty,
              let pid = request.pid,
              let windowId = request.windowId,
              let expectedBounds = request.expectedWindowBounds,
              let pointer = request.screenPoint,
              expectedBounds.isFiniteAndPositive,
              pointer.isFinite
        else {
            throw ExperimentalExactWindowError.refused("Wire-contract fixture is incomplete")
        }
        writeResponse([
            "ok": true,
            "result": experimentalDispatchResultDictionary(
                observationId: observationId,
                targetPid: pid,
                targetWindowId: windowId,
                targetWindowBounds: expectedBounds.cgRect,
                pointerBefore: pointer.cgPoint,
                pointerAfter: pointer.cgPoint
            ),
        ])
    } else if request.command == "dispatch" {
        guard request.experimental == true, request.route == routeName else {
            throw ExperimentalExactWindowError.refused(
                "Explicit experimental route selection is required"
            )
        }
        guard let observationId = request.observationId, !observationId.isEmpty,
              let action = request.action,
              let pid = request.pid,
              let windowId = request.windowId,
              let screenPoint = request.screenPoint,
              let windowPoint = request.windowPoint,
              let expectedBounds = request.expectedWindowBounds,
              let expectedElement = request.expectedElement,
              screenPoint.isFinite,
              windowPoint.isFinite,
              expectedBounds.isFiniteAndPositive,
              expectedElement.bounds.isFiniteAndPositive,
              !expectedElement.locator.contains(where: { $0 < 0 }),
              !expectedElement.role.isEmpty
        else {
            throw ExperimentalExactWindowError.refused("Dispatch target is incomplete")
        }
        let recipe = try experimentalEventRecipe(
            action: action,
            direction: request.direction,
            amount: request.amount
        )
        let receipt = try ExperimentalExactWindowSPI.shared.dispatch(
            target: ExperimentalTarget(
                pid: pid,
                windowId: windowId,
                screenPoint: screenPoint.cgPoint,
                windowPoint: windowPoint.cgPoint,
                expectedBounds: expectedBounds.cgRect,
                expectedElement: expectedElement
            ),
            recipe: recipe
        )
        writeResponse([
            "ok": true,
            "result": experimentalDispatchResultDictionary(
                observationId: observationId,
                targetPid: receipt.targetPid,
                targetWindowId: receipt.targetWindowId,
                targetWindowBounds: expectedBounds.cgRect,
                pointerBefore: receipt.pointerBefore,
                pointerAfter: receipt.pointerAfter
            ),
        ])
    } else {
        throw ExperimentalExactWindowError.refused("Unknown helper command")
    }
} catch {
    writeResponse([
        "ok": false,
        "error": [
            "code": "EXPERIMENTAL_EXACT_WINDOW_REFUSED",
            "message": error.localizedDescription,
        ],
    ])
    exit(1)
}
