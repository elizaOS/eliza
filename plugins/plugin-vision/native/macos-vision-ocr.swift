// macOS Apple Vision OCR helper for @elizaos/plugin-vision (issue #9105 — per-OS
// native OCR fallback). Reads PNG/JPEG bytes from stdin, runs an accurate
// `VNRecognizeTextRequest` with language correction, and prints ONE JSON object
// on stdout:
//
//   {"lines":[{"text":..,"confidence":..,"boundingBox":{"x":..,"y":..,"width":..,"height":..}}],"fullText":..}
//
// Vision reports normalized, BOTTOM-LEFT-origin bounding boxes (x,y,width,height
// in 0..1, y growing upward). The other plugin-vision OCR providers use
// TOP-LEFT-origin PIXEL coordinates (display-absolute convention), so we convert
// here: pixelX = x*W, pixelY = (1 - y - height)*H, and scale width/height by the
// image dimensions. Empty/zero results still print a well-formed empty object so
// the Node side never has to special-case a missing stdout.

import AppKit
import Foundation
import Vision

struct OcrLine: Encodable {
    let text: String
    let confidence: Double
    let boundingBox: BBox
}

struct BBox: Encodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct OcrPayload: Encodable {
    let lines: [OcrLine]
    let fullText: String
}

func emit(_ payload: OcrPayload) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    if let data = try? encoder.encode(payload),
        let json = String(data: data, encoding: .utf8)
    {
        print(json)
    } else {
        print("{\"lines\":[],\"fullText\":\"\"}")
    }
}

let emptyPayload = OcrPayload(lines: [], fullText: "")

// Read the full image from stdin.
let inputData = FileHandle.standardInput.readDataToEndOfFile()
guard !inputData.isEmpty, let nsImage = NSImage(data: inputData),
    let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
    emit(emptyPayload)
    exit(0)
}

let pixelWidth = Double(cgImage.width)
let pixelHeight = Double(cgImage.height)
if pixelWidth <= 0 || pixelHeight <= 0 {
    emit(emptyPayload)
    exit(0)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    emit(emptyPayload)
    exit(0)
}

guard let observations = request.results, !observations.isEmpty else {
    emit(emptyPayload)
    exit(0)
}

var lines: [OcrLine] = []
for observation in observations {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let text = candidate.string
    if text.isEmpty { continue }

    // `observation.boundingBox` is normalized, bottom-left origin. Convert to
    // top-left-origin pixel coordinates matching the other OCR providers.
    let box = observation.boundingBox
    let pixelX = box.origin.x * pixelWidth
    let pixelY = (1.0 - box.origin.y - box.size.height) * pixelHeight
    let pixelW = box.size.width * pixelWidth
    let pixelH = box.size.height * pixelHeight

    lines.append(
        OcrLine(
            text: text,
            confidence: Double(candidate.confidence),
            boundingBox: BBox(
                x: pixelX,
                y: pixelY,
                width: pixelW,
                height: pixelH
            )
        )
    )
}

let fullText = lines.map { $0.text }.joined(separator: "\n")
emit(OcrPayload(lines: lines, fullText: fullText))
