import XCTest

@testable import SwabbleIOSContracts

// Covers `SwabbleWakeBridgeContract.isTriggerOnly` — the production gate
// (`SwabblePlugin.swift`) that decides whether a wake utterance is a bare
// trigger (start capture, no command yet) versus a full "trigger + command"
// turn. The existing contract tests exercise `textOnlyCommand` / payloads but
// not this branch, leaving the trigger-only wake-firing path unverified.
final class SwabbleTriggerGateTests: XCTestCase {
    private let triggers = ["eliza"]

    func testBareTriggerIsTriggerOnly() {
        XCTAssertTrue(
            SwabbleWakeBridgeContract.isTriggerOnly(
                transcript: "eliza", triggers: triggers))
    }

    func testTriggerWithTrailingCommandIsNotTriggerOnly() {
        XCTAssertFalse(
            SwabbleWakeBridgeContract.isTriggerOnly(
                transcript: "eliza turn on the lights", triggers: triggers))
    }

    func testFuzzyMisheardTriggerStillCountsAsTriggerOnly() {
        // "aliza" is within the fuzzy edit-distance threshold of "eliza", so a
        // SpeechRecognizer mishear of the bare trigger must still start capture.
        XCTAssertTrue(
            SwabbleWakeBridgeContract.isTriggerOnly(
                transcript: "aliza", triggers: triggers))
    }

    func testNonTriggerSpeechIsNotTriggerOnly() {
        XCTAssertFalse(
            SwabbleWakeBridgeContract.isTriggerOnly(
                transcript: "hello there", triggers: triggers))
    }

    func testEmptyTranscriptIsNotTriggerOnly() {
        XCTAssertFalse(
            SwabbleWakeBridgeContract.isTriggerOnly(
                transcript: "", triggers: triggers))
    }
}
