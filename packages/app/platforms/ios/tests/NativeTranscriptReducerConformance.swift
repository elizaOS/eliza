/**
 * Command-line conformance harness for the tracked iOS transcript reducer. It
 * executes every scenario from the shared language-neutral fixture and exits
 * nonzero on the first rejected-index or reduced-view mismatch.
 */

import Foundation

enum NativeTranscriptConformanceError: Error, CustomStringConvertible {
    case usage
    case malformedFixture(String)
    case mismatch(String)

    var description: String {
        switch self {
        case .usage:
            return "usage: native-transcript-conformance <fixture.json>"
        case .malformedFixture(let message), .mismatch(let message):
            return message
        }
    }
}

@main
enum NativeTranscriptReducerConformance {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else { throw NativeTranscriptConformanceError.usage }
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        guard
            let fixture = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let schema = fixture["schema"] as? String,
            let scenarios = fixture["scenarios"] as? [[String: Any]]
        else {
            throw NativeTranscriptConformanceError.malformedFixture("fixture root is malformed")
        }

        for scenario in scenarios {
            guard
                let name = scenario["name"] as? String,
                let events = scenario["events"] as? [Any],
                let expectedRejected = scenario["expectRejectedIndexes"] as? [NSNumber],
                let expectedView = scenario["expectView"] as? [String: Any]
            else {
                throw NativeTranscriptConformanceError.malformedFixture("scenario is malformed")
            }
            let result = try NativeTranscriptReducer().applyEnvelope([
                "schema": schema,
                "events": events,
            ])
            let expectedIndexes = expectedRejected.map(\.intValue)
            guard result.rejectedIndexes == expectedIndexes else {
                throw NativeTranscriptConformanceError.mismatch(
                    "\(name): rejected \(result.rejectedIndexes), expected \(expectedIndexes)"
                )
            }
            guard try normalized(result.view) == normalized(expectedView) else {
                throw NativeTranscriptConformanceError.mismatch("\(name): reduced view differs")
            }
        }
        print("iOS native transcript conformance: \(scenarios.count) scenarios passed")
    }

    private static func normalized(_ value: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }
}
