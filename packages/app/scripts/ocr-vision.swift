// Batch on-device OCR over PNG/JPEG screenshots using Apple's Vision framework.
// Reads newline-delimited absolute image paths on stdin, emits one NDJSON record
// per image: {"path","ok","text","lines","words","meanConfidence"}. Chosen over
// tesseract because Vision ships with macOS (no model download), is materially
// more accurate on rendered UI type, and reports per-observation confidence the
// triage rules use to distinguish "blank pixels" from "unreadable pixels".
import Foundation
import Vision
import AppKit

func ocr(_ path: String) -> [String: Any] {
  guard let img = NSImage(contentsOfFile: path),
        let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    return ["path": path, "ok": false, "text": "", "lines": [String](), "words": 0, "meanConfidence": 0.0]
  }
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = true
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  do { try handler.perform([req]) } catch {
    return ["path": path, "ok": false, "text": "", "lines": [String](), "words": 0, "meanConfidence": 0.0]
  }
  var lines: [String] = []
  var confSum: Float = 0
  var confN: Int = 0
  for obs in (req.results ?? []) {
    guard let cand = obs.topCandidates(1).first else { continue }
    lines.append(cand.string)
    confSum += cand.confidence
    confN += 1
  }
  let text = lines.joined(separator: "\n")
  let words = text.split { $0 == " " || $0 == "\n" }.count
  return [
    "path": path, "ok": true, "text": text, "lines": lines,
    "words": words, "meanConfidence": confN > 0 ? Double(confSum) / Double(confN) : 0.0,
  ]
}

while let line = readLine(strippingNewline: true) {
  let p = line.trimmingCharacters(in: .whitespaces)
  if p.isEmpty { continue }
  let rec = ocr(p)
  if let data = try? JSONSerialization.data(withJSONObject: rec),
     let s = String(data: data, encoding: .utf8) {
    print(s)
    fflush(stdout)
  }
}
