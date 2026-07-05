// GENERATED FILE — DO NOT EDIT BY HAND.
// Source of truth: packages/app/scripts/lib/chat-failure-strings.mjs
// Regenerate: node packages/app/scripts/lib/chat-failure-strings.mjs --emit-swift
// Parity guard: packages/app/scripts/lib/chat-failure-strings.test.mjs
//
// The mobile chat-reply FAILURE vocabulary shared with mobile-local-chat-smoke.mjs.
// A candidate XCUITest reply matching any of these is an error render / broken
// pipeline and must FAIL the attempt (never count as a "genuine model reply").

enum ChatFailureStrings {
    static let ios: [String] = [
        "something went wrong",
        "backend is not running",
        "local backend is not running",
        "no local backend",
        "no local model",
        "no model registered",
        "no provider",
        "connect a provider",
        "waiting for the model download",
        "timed out",
        "<think\\b",
        "<\\/think>",
        "\\/?\\bno_think\\b",
    ]

    static let android: [String] = [
        "something went wrong",
        "no local gguf",
        "no local model",
        "no model registered",
        "no provider",
        "connect a provider",
        "device_disconnected",
        "device_timeout",
        "timed out",
        "chat generation failed",
        "waiting for the model download",
        "set chat routing",
        "progress:\\s*0%",
        "<think\\b",
        "<\\/think>",
        "\\/?\\bno_think\\b",
    ]
}
