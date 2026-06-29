import XCTest
@testable import TalkModeIOSContracts

final class TalkModeBridgeContractTests: XCTestCase {
    func testTranscriptPayloadPreservesBridgeFields() {
        let interim = TalkModeBridgeContract.transcriptPayload(
            transcript: " hello eliza ",
            isFinal: false
        )
        XCTAssertEqual(interim["transcript"] as? String, " hello eliza ")
        XCTAssertEqual(interim["isFinal"] as? Bool, false)

        let final = TalkModeBridgeContract.transcriptPayload(
            transcript: "hello eliza",
            isFinal: true
        )
        XCTAssertEqual(final["transcript"] as? String, "hello eliza")
        XCTAssertEqual(final["isFinal"] as? Bool, true)
    }

    func testBargeInInterruptIgnoresShortBlipsAndSelfEcho() {
        XCTAssertFalse(TalkModeBridgeContract.shouldInterruptSpeech(
            transcript: "ok",
            lastSpokenText: "The answer is coming now"
        ))
        XCTAssertFalse(TalkModeBridgeContract.shouldInterruptSpeech(
            transcript: "answer is coming",
            lastSpokenText: "The answer is coming now"
        ))
        XCTAssertTrue(TalkModeBridgeContract.shouldInterruptSpeech(
            transcript: "stop",
            lastSpokenText: "The answer is coming now"
        ))
    }

    func testStateAndPermissionPayloads() {
        let state = TalkModeBridgeContract.statePayload(
            state: "speaking",
            previousState: "processing",
            statusText: "Speaking",
            usingSystemTts: true
        )
        XCTAssertEqual(state["state"] as? String, "speaking")
        XCTAssertEqual(state["previousState"] as? String, "processing")
        XCTAssertEqual(state["statusText"] as? String, "Speaking")
        XCTAssertEqual(state["usingSystemTts"] as? Bool, true)

        let permission = TalkModeBridgeContract.permissionPayload(
            microphone: "granted",
            speechRecognition: "prompt"
        )
        XCTAssertEqual(permission["microphone"] as? String, "granted")
        XCTAssertEqual(permission["speechRecognition"] as? String, "prompt")
    }
}
