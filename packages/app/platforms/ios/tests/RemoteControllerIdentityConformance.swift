/**
 Command-line native conformance checks for the controller bridge's canonical
 JSON and P-256 signature representation. It compiles with the tracked plugin
 so native protocol drift fails before an iOS package is claimed as usable.
 */
import CryptoKit
import Foundation

enum RemoteControllerIdentityConformanceError: Error {
    case mismatch(String)
}

@main
enum RemoteControllerIdentityConformance {
    static func main() throws {
        let value: [String: Any] = [
            "z": [3, NSNull(), true] as [Any],
            "a": ["slash": "https://example.test/a/b", "quote": "\"line\n"] as [String: Any],
        ]
        let canonical = String(decoding: try RemoteControllerCodec.canonicalData(value), as: UTF8.self)
        let expected = #"{"a":{"quote":"\"line\n","slash":"https://example.test/a/b"},"z":[3,null,true]}"#
        guard canonical == expected else {
            throw RemoteControllerIdentityConformanceError.mismatch("canonical JSON differs: \(canonical)")
        }

        let privateKey = P256.Signing.PrivateKey()
        let body: [String: Any] = ["commandId": "command-1", "sequence": 1, "payload": value]
        let bytes = try RemoteControllerCodec.canonicalData(body)
        let signature = try privateKey.signature(for: bytes)
        let roundTrip = try P256.Signing.ECDSASignature(derRepresentation: signature.derRepresentation)
        guard privateKey.publicKey.isValidSignature(roundTrip, for: bytes) else {
            throw RemoteControllerIdentityConformanceError.mismatch("P-256 DER signature did not round-trip")
        }

        let plugin = RemoteControllerIdentityPlugin()
        let methods = Set(plugin.pluginMethods.map(\.name))
        let expectedMethods: Set<String> = [
            "getOrCreateIdentity", "createCommand", "acknowledgeEnqueue",
            "openResult", "openStartReceipt", "clearSessionState",
        ]
        guard methods == expectedMethods else {
            throw RemoteControllerIdentityConformanceError.mismatch("Capacitor method contract differs")
        }
        print("iOS remote controller native conformance passed")
    }
}
