// SPDX-License-Identifier: MIT
/** Isolates the dynamically probed private ABI used only by the optional direct helper. */

import AppKit
import CoreGraphics
import Darwin
import Foundation

struct ExperimentalCapability {
    let minimumMacOSMet: Bool
    let missingSymbols: [String]

    var available: Bool { minimumMacOSMet && missingSymbols.isEmpty }
}

struct ExperimentalTarget {
    let pid: pid_t
    let windowId: CGWindowID
    let screenPoint: CGPoint
    let windowPoint: CGPoint
    let expectedBounds: CGRect
    let expectedElement: ExperimentalElementFingerprint
}

struct ExperimentalDispatchReceipt {
    let targetPid: pid_t
    let targetWindowId: CGWindowID
    let pointerBefore: CGPoint
    let pointerAfter: CGPoint
}

private enum ExperimentalElementValidation {
    case fullFingerprint
    case immutableIdentity
}

final class ExperimentalExactWindowSPI {
    static let shared = ExperimentalExactWindowSPI()

    private static let frameworkPath = "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
    private static let applicationServicesPath = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
    private static let postToPidSymbol = "SLEventPostToPid"
    private static let setIntegerFieldSymbol = "SLEventSetIntegerValueField"
    private static let setWindowLocationSymbol = "CGEventSetWindowLocation"
    private static let postEventRecordSymbol = "SLPSPostEventRecordTo"
    private static let getProcessForPIDSymbol = "GetProcessForPID"

    private typealias PostToPidFunction = @convention(c) (pid_t, UnsafeMutableRawPointer?) -> Void
    private typealias SetIntegerFieldFunction = @convention(c) (UnsafeMutableRawPointer?, UInt32, Int64) -> Void
    private typealias SetWindowLocationFunction = @convention(c) (UnsafeMutableRawPointer?, Double, Double) -> Void
    private typealias PostEventRecordFunction = @convention(c) (UnsafeRawPointer?, UnsafePointer<UInt8>?) -> Int32
    private typealias GetProcessForPIDFunction = @convention(c) (pid_t, UnsafeMutableRawPointer?) -> Int32

    private let postToPidFunction: PostToPidFunction?
    private let setIntegerFieldFunction: SetIntegerFieldFunction?
    private let setWindowLocationFunction: SetWindowLocationFunction?
    private let postEventRecordFunction: PostEventRecordFunction?
    private let getProcessForPIDFunction: GetProcessForPIDFunction?
    let capability: ExperimentalCapability

    private init() {
        let framework = dlopen(Self.frameworkPath, RTLD_LAZY | RTLD_LOCAL)
        let applicationServices = dlopen(Self.applicationServicesPath, RTLD_LAZY | RTLD_LOCAL)
        postToPidFunction = Self.resolve(framework, Self.postToPidSymbol)
        setIntegerFieldFunction = Self.resolve(framework, Self.setIntegerFieldSymbol)
        setWindowLocationFunction = Self.resolve(framework, Self.setWindowLocationSymbol)
        postEventRecordFunction = Self.resolve(framework, Self.postEventRecordSymbol)
        getProcessForPIDFunction = Self.resolve(applicationServices, Self.getProcessForPIDSymbol)
        var missing: [String] = []
        if postToPidFunction == nil { missing.append(Self.postToPidSymbol) }
        if setIntegerFieldFunction == nil { missing.append(Self.setIntegerFieldSymbol) }
        if setWindowLocationFunction == nil { missing.append(Self.setWindowLocationSymbol) }
        if postEventRecordFunction == nil { missing.append(Self.postEventRecordSymbol) }
        if getProcessForPIDFunction == nil { missing.append(Self.getProcessForPIDSymbol) }
        capability = ExperimentalCapability(
            minimumMacOSMet: ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 14,
            missingSymbols: missing
        )
    }

    func dispatch(target: ExperimentalTarget, recipe: [ExperimentalEventStep]) throws -> ExperimentalDispatchReceipt {
        guard capability.available else {
            throw ExperimentalExactWindowError.refused("Private exact-window capability probe failed")
        }
        try validate(target)
        guard let source = CGEventSource(stateID: .privateState) else {
            throw ExperimentalExactWindowError.refused("Could not create a private event source")
        }
        guard let postToPidFunction else { throw unavailable() }
        let preparedEvents = try recipe.map { step in
            let point = step.pointKind == .target
                ? (target.screenPoint, target.windowPoint)
                : (CGPoint(x: -1, y: -1), CGPoint(x: -1, y: -1))
            let event = try makeEvent(step: step, source: source, screenPoint: point.0)
            try stamp(event: event, target: target, windowPoint: point.1, step: step)
            return event
        }
        guard let pointerObservationBefore = CGEvent(source: nil) else {
            throw ExperimentalExactWindowError.refused("Physical pointer provenance is unavailable")
        }
        let pointerBefore = pointerObservationBefore.location
        var preparedEventIndex = 0
        try experimentalDispatchSequence(
            recipe: recipe,
            beginFocus: { try self.beginSyntheticTargetFocus(target: target) },
            revalidate: {
                try self.validate(target, elementValidation: .immutableIdentity)
            },
            post: { step in
                let event = preparedEvents[preparedEventIndex]
                preparedEventIndex += 1
                postToPidFunction(target.pid, Unmanaged.passUnretained(event).toOpaque())
                if step.delayMicroseconds > 0 { usleep(step.delayMicroseconds) }
            },
            endFocus: { try self.endSyntheticTargetFocus($0) }
        )
        guard let pointerObservationAfter = CGEvent(source: nil) else {
            throw ExperimentalExactWindowError.refused("Physical pointer provenance is unavailable")
        }
        let pointerAfter = pointerObservationAfter.location
        guard pointerAfter == pointerBefore else {
            throw ExperimentalExactWindowError.refused("Physical pointer moved during private dispatch")
        }
        return ExperimentalDispatchReceipt(
            targetPid: target.pid,
            targetWindowId: target.windowId,
            pointerBefore: pointerBefore,
            pointerAfter: pointerAfter
        )
    }

    private func validate(
        _ target: ExperimentalTarget,
        elementValidation: ExperimentalElementValidation = .fullFingerprint
    ) throws {
        guard target.pid > 0,
              target.screenPoint.x.isFinite,
              target.screenPoint.y.isFinite,
              target.windowPoint.x.isFinite,
              target.windowPoint.y.isFinite,
              target.expectedBounds.width > 0,
              target.expectedBounds.height > 0,
              CGRect(origin: .zero, size: target.expectedBounds.size).contains(target.windowPoint)
        else {
            throw ExperimentalExactWindowError.refused("Target coordinates or bounds are invalid")
        }
        guard let windows = CGWindowListCopyWindowInfo(
            [.optionIncludingWindow, .excludeDesktopElements],
            target.windowId
        ) as? [[String: Any]] else {
            throw ExperimentalExactWindowError.refused(
                "Exact PID/CGWindowID target metadata is unavailable"
            )
        }
        guard windows.count == 1,
              let info = windows.first,
              (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value == target.windowId,
              (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == target.pid,
              (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true,
              let boundsValue = info[kCGWindowBounds as String],
              let boundsDictionary = boundsValue as? NSDictionary,
              CFGetTypeID(boundsDictionary) == CFDictionaryGetTypeID(),
              let actualBounds = CGRect(dictionaryRepresentation: boundsDictionary),
              experimentalBoundsMatch(actualBounds, target.expectedBounds),
              abs(actualBounds.origin.x + target.windowPoint.x - target.screenPoint.x) <= 1,
              abs(actualBounds.origin.y + target.windowPoint.y - target.screenPoint.y) <= 1
        else {
            throw ExperimentalExactWindowError.refused(
                "Exact PID/CGWindowID target is stale, off-screen, ambiguous, or moved"
            )
        }
        try validateElement(target, validation: elementValidation)
    }

    private func validateElement(
        _ target: ExperimentalTarget,
        validation: ExperimentalElementValidation
    ) throws {
        guard AXIsProcessTrusted() else {
            throw ExperimentalExactWindowError.refused(
                "Accessibility trust is required for exact element revalidation"
            )
        }
        let app = AXUIElementCreateApplication(target.pid)
        guard let focusedWindowValue = copyAttribute(
            app,
            kAXFocusedWindowAttribute as CFString
        ), CFGetTypeID(focusedWindowValue) == AXUIElementGetTypeID() else {
            throw ExperimentalExactWindowError.refused(
                "The target accessibility window is unavailable after focus"
            )
        }
        let focusedWindow = focusedWindowValue as! AXUIElement
        guard let focusedBounds = bounds(focusedWindow),
              experimentalBoundsMatch(focusedBounds, target.expectedBounds, tolerance: 2)
        else {
            throw ExperimentalExactWindowError.refused(
                "The target accessibility window changed after focus"
            )
        }
        let element = try resolveElement(
            root: focusedWindow,
            locator: target.expectedElement.locator
        )
        let matchesExpected = switch validation {
        case .fullFingerprint:
            matchesFullFingerprint(element: element, expected: target.expectedElement)
        case .immutableIdentity:
            matchesImmutableIdentity(element: element, expected: target.expectedElement)
        }
        guard matchesExpected else {
            throw ExperimentalExactWindowError.refused(
                "The approved accessibility element changed after focus; capture and approve again"
            )
        }
    }

    private func copyAttribute(_ element: AXUIElement, _ attribute: CFString) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, attribute, &value) == .success ? value : nil
    }

    private func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
        copyAttribute(element, attribute) as? String
    }

    private func boolAttribute(
        _ element: AXUIElement,
        _ attribute: CFString
    ) -> Bool? {
        (copyAttribute(element, attribute) as? NSNumber)?.boolValue
    }

    private func pointAttribute(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
        guard let raw = copyAttribute(element, attribute),
              CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        let value = raw as! AXValue
        guard AXValueGetType(value) == .cgPoint else { return nil }
        var point = CGPoint.zero
        return AXValueGetValue(value, .cgPoint, &point) ? point : nil
    }

    private func sizeAttribute(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
        guard let raw = copyAttribute(element, attribute),
              CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        let value = raw as! AXValue
        guard AXValueGetType(value) == .cgSize else { return nil }
        var size = CGSize.zero
        return AXValueGetValue(value, .cgSize, &size) ? size : nil
    }

    private func bounds(_ element: AXUIElement) -> CGRect? {
        guard let point = pointAttribute(element, kAXPositionAttribute as CFString),
              let size = sizeAttribute(element, kAXSizeAttribute as CFString) else { return nil }
        return CGRect(origin: point, size: size)
    }

    private func children(_ element: AXUIElement) -> [AXUIElement] {
        (copyAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement]) ?? []
    }

    private func resolveElement(root: AXUIElement, locator: [Int]) throws -> AXUIElement {
        var element = root
        for index in locator {
            let available = children(element)
            guard index >= 0, index < available.count else {
                throw ExperimentalExactWindowError.refused(
                    "The approved accessibility element locator is stale"
                )
            }
            element = available[index]
        }
        return element
    }

    private func actionNames(_ element: AXUIElement) -> [String]? {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success else { return nil }
        return names as? [String]
    }

    private func isSecure(role: String, subrole: String?, description: String?) -> Bool {
        let haystack = [role, subrole ?? "", description ?? ""]
            .joined(separator: " ")
            .lowercased()
        return haystack.contains("secure") || haystack.contains("password")
    }

    private func redactSensitive(_ value: String) -> String {
        let patterns = [
            #"(?i)\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*\S+"#,
            #"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+"#,
            #"://[^/@\s]+:[^/@\s]+@"#,
        ]
        var redacted = value
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let range = NSRange(redacted.startIndex..<redacted.endIndex, in: redacted)
            redacted = regex.stringByReplacingMatches(
                in: redacted,
                range: range,
                withTemplate: "[redacted]"
            )
        }
        return redacted
    }

    private func matchesImmutableIdentity(
        element: AXUIElement,
        expected: ExperimentalElementFingerprint
    ) -> Bool {
        guard let role = stringAttribute(element, kAXRoleAttribute as CFString) else { return false }
        let subrole = stringAttribute(element, kAXSubroleAttribute as CFString)
        let title = stringAttribute(element, kAXTitleAttribute as CFString)
        let rawLabel = title ?? stringAttribute(element, kAXLabelValueAttribute as CFString)
        let rawDescription = stringAttribute(element, kAXDescriptionAttribute as CFString)
        let secure = isSecure(role: role, subrole: subrole, description: rawDescription)
        let label = rawLabel.map(redactSensitive)
        let description = rawDescription.map(redactSensitive)
        guard let actualBounds = bounds(element) else { return false }
        return role == expected.role &&
            subrole == expected.subrole &&
            label == expected.label &&
            description == expected.elementDescription &&
            experimentalBoundsMatch(actualBounds, expected.bounds.cgRect, tolerance: 2) &&
            secure == expected.secure
    }

    private func matchesFullFingerprint(
        element: AXUIElement,
        expected: ExperimentalElementFingerprint
    ) -> Bool {
        guard matchesImmutableIdentity(element: element, expected: expected),
              let actions = actionNames(element),
              let enabled = boolAttribute(element, kAXEnabledAttribute as CFString),
              let focused = boolAttribute(element, kAXFocusedAttribute as CFString)
        else { return false }
        let value = expected.secure
            ? nil
            : stringAttribute(element, kAXValueAttribute as CFString).map(redactSensitive)
        let selected = (copyAttribute(element, kAXSelectedAttribute as CFString) as? NSNumber)?.boolValue
        return value == expected.value &&
            actions.sorted() == expected.actions.sorted() &&
            enabled == expected.enabled &&
            focused == expected.focused &&
            selected == expected.selected
    }

    private func makeEvent(
        step: ExperimentalEventStep,
        source: CGEventSource,
        screenPoint: CGPoint
    ) throws -> CGEvent {
        if step.kind == .scroll {
            guard let event = CGEvent(
                scrollWheelEvent2Source: source,
                units: .pixel,
                wheelCount: 2,
                wheel1: step.deltaY,
                wheel2: step.deltaX,
                wheel3: 0
            ) else {
                throw ExperimentalExactWindowError.refused("Could not create scroll event")
            }
            event.location = screenPoint
            return event
        }
        let type: CGEventType
        switch step.kind {
        case .moved: type = .mouseMoved
        case .down: type = .leftMouseDown
        case .up: type = .leftMouseUp
        case .scroll:
            throw ExperimentalExactWindowError.refused("Invalid event recipe")
        }
        guard let event = CGEvent(
            mouseEventSource: source,
            mouseType: type,
            mouseCursorPosition: screenPoint,
            mouseButton: .left
        ) else {
            throw ExperimentalExactWindowError.refused("Could not create pointer event")
        }
        return event
    }

    private func stamp(
        event: CGEvent,
        target: ExperimentalTarget,
        windowPoint: CGPoint,
        step: ExperimentalEventStep
    ) throws {
        let window = Int64(target.windowId)
        let group = Int64(DispatchTime.now().uptimeNanoseconds % 1_000_000_000)
        try setInteger(event, field: 0, value: step.phase)
        try setInteger(event, field: 1, value: step.clickState)
        try setInteger(event, field: 3, value: 0)
        try setInteger(event, field: 7, value: step.kind == .scroll ? 7 : 3)
        try setInteger(event, field: 40, value: Int64(target.pid))
        try setInteger(event, field: 51, value: window)
        try setInteger(event, field: 58, value: group)
        try setInteger(event, field: 91, value: window)
        try setInteger(event, field: 92, value: window)
        try setWindowLocation(event, point: windowPoint)
    }

    private struct FocusContext { let psn: [UInt8]; let windowId: CGWindowID; let active: Bool }

    private func beginSyntheticTargetFocus(target: ExperimentalTarget) throws -> FocusContext {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid {
            return FocusContext(psn: [], windowId: target.windowId, active: false)
        }
        guard let getProcessForPIDFunction else { throw unavailable() }
        var psn = [UInt8](repeating: 0, count: 8)
        let status = psn.withUnsafeMutableBytes { bytes in
            getProcessForPIDFunction(target.pid, bytes.baseAddress)
        }
        guard status == 0 else {
            throw ExperimentalExactWindowError.refused("Could not resolve target PID")
        }
        try postFocus(psn: psn, windowId: target.windowId, focused: true)
        usleep(40_000)
        return FocusContext(psn: psn, windowId: target.windowId, active: true)
    }

    private func endSyntheticTargetFocus(_ context: FocusContext) throws {
        guard context.active else { return }
        usleep(100_000)
        try postFocus(psn: context.psn, windowId: context.windowId, focused: false)
        usleep(40_000)
    }

    private func postFocus(psn: [UInt8], windowId: CGWindowID, focused: Bool) throws {
        guard let postEventRecordFunction else { throw unavailable() }
        var record = [UInt8](repeating: 0, count: 0xF8)
        record[0x04] = 0xF8
        record[0x08] = 0x0D
        record[0x3C] = UInt8(truncatingIfNeeded: windowId)
        record[0x3D] = UInt8(truncatingIfNeeded: windowId >> 8)
        record[0x3E] = UInt8(truncatingIfNeeded: windowId >> 16)
        record[0x3F] = UInt8(truncatingIfNeeded: windowId >> 24)
        record[0x8A] = focused ? 0x01 : 0x02
        let status = psn.withUnsafeBytes { psnBytes in
            record.withUnsafeBufferPointer { recordBytes in
                postEventRecordFunction(psnBytes.baseAddress, recordBytes.baseAddress)
            }
        }
        guard status == 0 else {
            throw ExperimentalExactWindowError.refused("Synthetic target-only focus failed")
        }
    }

    private func setInteger(_ event: CGEvent, field: UInt32, value: Int64) throws {
        guard let setIntegerFieldFunction else { throw unavailable() }
        setIntegerFieldFunction(Unmanaged.passUnretained(event).toOpaque(), field, value)
    }

    private func setWindowLocation(_ event: CGEvent, point: CGPoint) throws {
        guard let setWindowLocationFunction else { throw unavailable() }
        setWindowLocationFunction(Unmanaged.passUnretained(event).toOpaque(), point.x, point.y)
    }

    private func unavailable() -> ExperimentalExactWindowError {
        .refused("Private exact-window ABI is unavailable")
    }

    private static func resolve<T>(_ handle: UnsafeMutableRawPointer?, _ symbol: String) -> T? {
        guard let handle, let pointer = dlsym(handle, symbol) else { return nil }
        return unsafeBitCast(pointer, to: T.self)
    }
}
