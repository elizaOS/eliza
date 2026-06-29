import XCTest
@testable import SwabbleIOSContracts

final class SwabbleBridgeContractTests: XCTestCase {
    func testTextOnlyWakeCommandUsesTriggerAndMinimumLength() {
        let command = SwabbleWakeBridgeContract.textOnlyCommand(
            transcript: "eliza turn on the lights",
            triggers: ["eliza"],
            minCommandLength: 3
        )
        XCTAssertEqual(command, "turn on the lights")

        let tooShort = SwabbleWakeBridgeContract.textOnlyCommand(
            transcript: "eliza go",
            triggers: ["eliza"],
            minCommandLength: 3
        )
        XCTAssertNil(tooShort)
    }

    func testFuzzyTriggerStillFiresFromSpeechRecognizerMiss() {
        let command = SwabbleWakeBridgeContract.textOnlyCommand(
            transcript: "aliza start the timer",
            triggers: ["eliza"],
            minCommandLength: 3
        )
        XCTAssertEqual(command, "start the timer")
    }

    func testWakePayloadMatchesJsBridgeContract() {
        let payload = SwabbleWakeBridgeContract.wakeWordPayload(
            match: SwabbleBridgeMatch(
                triggerWord: "eliza",
                triggerEndTime: 0.6,
                postGap: 0.45,
                command: "turn on the lights"
            ),
            transcript: "eliza turn on the lights",
            confidence: 0.92
        )

        XCTAssertEqual(payload["wakeWord"] as? String, "eliza")
        XCTAssertEqual(payload["command"] as? String, "turn on the lights")
        XCTAssertEqual(payload["transcript"] as? String, "eliza turn on the lights")
        XCTAssertEqual(payload["postGap"] as? Double, 0.45)
        XCTAssertEqual(payload["confidence"] as? Double, 0.92)
    }

    func testTriggerOnlyPayloadStartsCaptureWithoutCommand() {
        let payload = SwabbleWakeBridgeContract.triggerOnlyPayload(
            trigger: "eliza",
            transcript: "eliza"
        )
        XCTAssertEqual(payload["wakeWord"] as? String, "eliza")
        XCTAssertEqual(payload["command"] as? String, "")
        XCTAssertEqual(payload["postGap"] as? Double, 0.0)
    }
}
