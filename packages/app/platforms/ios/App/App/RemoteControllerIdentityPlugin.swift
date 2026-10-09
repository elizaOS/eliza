/**
 Owns the iOS remote-controller identity, protocol signing, envelope crypto, and
 durable per-session sequence state. Private P-256 material is stored in the
 Keychain and never crosses the Capacitor bridge.
 */
import Capacitor
import CryptoKit
import Foundation
import Security

private enum RemoteControllerError: Error, LocalizedError {
    case invalid(String)
    case unavailable(String)

    var errorDescription: String? {
        switch self {
        case .invalid(let message), .unavailable(let message): return message
        }
    }
}

enum RemoteControllerCodec {
    static let maxBytes = 1_048_576

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decodeBase64url(_ value: Any?) throws -> Data {
        guard let value = value as? String, !value.isEmpty else {
            throw RemoteControllerError.invalid("Remote controller base64url value is invalid.")
        }
        var encoded = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let data = Data(base64Encoded: encoded) else {
            throw RemoteControllerError.invalid("Remote controller base64url value is invalid.")
        }
        return data
    }

    static func canonicalData(_ value: Any) throws -> Data {
        var budget = maxBytes
        let text = try canonical(value, depth: 0, budget: &budget)
        guard let data = text.data(using: .utf8), data.count <= maxBytes else {
            throw RemoteControllerError.invalid("Remote controller value exceeds canonical JSON limits.")
        }
        return data
    }

    private static func canonical(_ value: Any, depth: Int, budget: inout Int) throws -> String {
        guard depth <= 64, budget > 0 else {
            throw RemoteControllerError.invalid("Remote controller value exceeds canonical JSON limits.")
        }
        budget -= 1
        if value is NSNull { return "null" }
        if let value = value as? String { return try jsonScalar(value) }
        if let value = value as? NSNumber {
            if CFGetTypeID(value) == CFBooleanGetTypeID() { return value.boolValue ? "true" : "false" }
            guard value.doubleValue.isFinite else {
                throw RemoteControllerError.invalid("Remote controller number is invalid.")
            }
            return try jsonScalar(value)
        }
        if let value = value as? [Any] {
            return "[" + (try value.map { try canonical($0, depth: depth + 1, budget: &budget) }).joined(separator: ",") + "]"
        }
        guard let value = value as? [String: Any] else {
            throw RemoteControllerError.invalid("Remote controller JSON value is invalid.")
        }
        let keys = value.keys.sorted { left, right in
            left.utf16.lexicographicallyPrecedes(right.utf16)
        }
        let fields = try keys.map { key -> String in
            guard let member = value[key] else {
                throw RemoteControllerError.invalid("Remote controller object is invalid.")
            }
            return try jsonScalar(key) + ":" + canonical(member, depth: depth + 1, budget: &budget)
        }
        return "{" + fields.joined(separator: ",") + "}"
    }

    private static func jsonScalar(_ value: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: [value], options: [.withoutEscapingSlashes])
        guard var text = String(data: data, encoding: .utf8), text.count >= 2 else {
            throw RemoteControllerError.invalid("Remote controller JSON value is invalid.")
        }
        text.removeFirst()
        text.removeLast()
        return text
    }

    static func digest(_ value: Any) throws -> String {
        base64url(Data(SHA256.hash(data: try canonicalData(value))))
    }
}

private final class RemoteControllerKeychain {
    private let service = "ai.eliza.remote-controller.v1"

    func read(_ account: String) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw RemoteControllerError.unavailable("Secure controller storage is unavailable.")
        }
        return data
    }

    func write(_ data: Data, account: String) throws {
        let key: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let values: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let update = SecItemUpdate(key as CFDictionary, values as CFDictionary)
        if update == errSecItemNotFound {
            var created = key
            values.forEach { created[$0.key] = $0.value }
            guard SecItemAdd(created as CFDictionary, nil) == errSecSuccess else {
                throw RemoteControllerError.unavailable("Secure controller storage is unavailable.")
            }
            return
        }
        guard update == errSecSuccess else {
            throw RemoteControllerError.unavailable("Secure controller storage is unavailable.")
        }
    }
}

private final class RemoteControllerStore {
    private let keychain = RemoteControllerKeychain()
    private let queue = DispatchQueue(label: "ai.eliza.remote-controller.identity")
    private let deviceAccount = "controller-device-id"

    func mutate<T>(_ operation: () throws -> T) throws -> T { try queue.sync(execute: operation) }

    func deviceId() throws -> String {
        if let data = try keychain.read(deviceAccount) {
            guard let value = String(data: data, encoding: .utf8), Self.identifier(value) else {
                throw RemoteControllerError.invalid("Stored controller device identity is corrupt.")
            }
            return value
        }
        let created = UUID().uuidString.lowercased()
        try keychain.write(Data(created.utf8), account: deviceAccount)
        return created
    }

    func load(ownerId: String, deviceId: String) throws -> [String: Any]? {
        guard let data = try keychain.read(account(ownerId: ownerId, deviceId: deviceId)) else { return nil }
        guard let record = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              try valid(record: record, ownerId: ownerId, deviceId: deviceId) else {
            throw RemoteControllerError.invalid("Stored controller identity is corrupt.")
        }
        return record
    }

    func save(_ record: [String: Any], ownerId: String, deviceId: String) throws {
        let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys, .withoutEscapingSlashes])
        try keychain.write(data, account: account(ownerId: ownerId, deviceId: deviceId))
    }

    private func account(ownerId: String, deviceId: String) -> String {
        let digest = SHA256.hash(data: Data("\(ownerId)\0\(deviceId)".utf8))
        return "identity-" + digest.map { String(format: "%02x", $0) }.joined()
    }

    static func identifier(_ value: Any?) -> Bool {
        guard let value = value as? String, !value.isEmpty, value.count <= 256 else { return false }
        return value.range(of: "^[A-Za-z0-9._:-]+$", options: .regularExpression) != nil
    }

    private func valid(record: [String: Any], ownerId: String, deviceId: String) throws -> Bool {
        guard (record["version"] as? NSNumber)?.intValue == 1,
              let identity = record["identity"] as? [String: Any],
              (identity["version"] as? NSNumber)?.intValue == 1,
              identity["role"] as? String == "controller",
              identity["ownerId"] as? String == ownerId,
              identity["deviceId"] as? String == deviceId,
              identity["platform"] as? String == "ios",
              Self.identifier(identity["keyId"]),
              Self.identifier(identity["ownerId"]),
              Self.identifier(identity["deviceId"]),
              Self.displayName(identity["displayName"], max: 128),
              let createdAt = identity["createdAt"] as? NSNumber,
              createdAt.int64Value >= 0,
              let signingEncoded = record["signingPrivateKey"] as? String,
              let encryptionEncoded = record["encryptionPrivateKey"] as? String else { return false }
        let signingData = try RemoteControllerCodec.decodeBase64url(signingEncoded)
        let encryptionData = try RemoteControllerCodec.decodeBase64url(encryptionEncoded)
        guard signingData.count == 32, encryptionData.count == 32,
              let signing = try? P256.Signing.PrivateKey(rawRepresentation: signingData),
              let encryption = try? P256.KeyAgreement.PrivateKey(rawRepresentation: encryptionData),
              let signingJwk = identity["signingPublicKeyJwk"] as? [String: Any],
              let encryptionJwk = identity["encryptionPublicKeyJwk"] as? [String: Any],
              try publicJwk(signing.publicKey.rawRepresentation) == RemoteControllerCodec.canonicalData(signingJwk),
              try publicJwk(encryption.publicKey.rawRepresentation) == RemoteControllerCodec.canonicalData(encryptionJwk),
              identity["keyId"] as? String == "p256:" + (try RemoteControllerCodec.digest([
                  "signingPublicKeyJwk": signingJwk,
                  "encryptionPublicKeyJwk": encryptionJwk,
              ])) else { return false }

        guard let sessions = record["sessionSequences"] as? [String: Any], sessions.count <= 256 else {
            return false
        }
        return sessions.allSatisfy { sessionId, value in
            guard Self.identifier(sessionId), let entry = value as? [String: Any],
                  Self.digest(entry["bindingDigest"]),
                  let sequence = entry["sequence"] as? NSNumber,
                  sequence.intValue >= 1, Double(sequence.intValue) == sequence.doubleValue else { return false }
            guard let pendingValue = entry["pending"] else { return true }
            guard let pending = pendingValue as? [String: Any],
                  Self.digest(pending["requestDigest"]),
                  Self.identifier(pending["commandId"]),
                  let expiresAt = pending["expiresAt"] as? NSNumber,
                  expiresAt.int64Value >= 0,
                  let command = pending["command"] as? [String: Any],
                  let body = command["body"] as? [String: Any],
                  let envelope = pending["envelope"] as? [String: Any],
                  envelope["messageKind"] as? String == "command",
                  command["signatureAlgorithm"] as? String == "ECDSA-P256-SHA256",
                  Self.identifier(command["signature"]),
                  body["commandId"] as? String == pending["commandId"] as? String,
                  envelope["commandId"] as? String == pending["commandId"] as? String,
                  (body["sequence"] as? NSNumber)?.intValue == sequence.intValue,
                  (envelope["sequence"] as? NSNumber)?.intValue == sequence.intValue,
                  (body["expiresAt"] as? NSNumber)?.int64Value == expiresAt.int64Value,
                  (envelope["expiresAt"] as? NSNumber)?.int64Value == expiresAt.int64Value,
                  Self.sameBinding(body, envelope) else { return false }
            return true
        }
    }

    private func publicJwk(_ raw: Data) throws -> Data {
        guard raw.count == 65, raw.first == 0x04 else { return Data() }
        return try RemoteControllerCodec.canonicalData([
            "kty": "EC", "crv": "P-256",
            "x": RemoteControllerCodec.base64url(raw[1..<33]),
            "y": RemoteControllerCodec.base64url(raw[33..<65]),
        ])
    }

    private static func digest(_ value: Any?) -> Bool {
        guard let value = value as? String else { return false }
        return value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    }

    static func displayName(_ value: Any?, max: Int = 256) -> Bool {
        guard let value = value as? String, !value.isEmpty, value.count <= max,
              value == value.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        return value.unicodeScalars.allSatisfy { $0.value > 0x1f && $0.value != 0x7f }
    }

    private static func sameBinding(_ left: [String: Any], _ right: [String: Any]) -> Bool {
        let keys = [
            "version", "ownerId", "grantId", "grantRevision", "sessionId", "controllerDeviceId",
            "controllerKeyId", "targetRuntimeId", "targetKeyId", "commandId",
        ]
        let first = Dictionary(uniqueKeysWithValues: keys.map { ($0, left[$0] ?? NSNull()) })
        let second = Dictionary(uniqueKeysWithValues: keys.map { ($0, right[$0] ?? NSNull()) })
        return (try? RemoteControllerCodec.canonicalData(first)) == (try? RemoteControllerCodec.canonicalData(second))
    }
}

@objc(RemoteControllerIdentityPlugin)
public final class RemoteControllerIdentityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RemoteControllerIdentityPlugin"
    public let jsName = "RemoteControllerIdentity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getOrCreateIdentity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createCommand", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledgeEnqueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openResult", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openStartReceipt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearSessionState", returnType: CAPPluginReturnPromise),
    ]

    private let store = RemoteControllerStore()
    private let actions: Set<String> = [
        "agent.request", "agent.message", "agent.pause", "agent.resume", "agent.stop", "agent.status",
    ]

    @objc public func getOrCreateIdentity(_ call: CAPPluginCall) {
        resolve(call) {
            try self.store.mutate {
                let ownerId = try self.requiredIdentifier(call, "ownerId")
                let displayName = try self.requiredString(call, "displayName", max: 128)
                guard call.getString("platform") == "ios" else {
                    throw RemoteControllerError.invalid("Controller platform must be ios.")
                }
                let deviceId = try self.store.deviceId()
                if let existing = try self.store.load(ownerId: ownerId, deviceId: deviceId),
                   let identity = existing["identity"] as? [String: Any] {
                    return identity
                }
                let signing = P256.Signing.PrivateKey()
                let encryption = P256.KeyAgreement.PrivateKey()
                let signingJwk = try self.publicJwk(signing.publicKey.rawRepresentation)
                let encryptionJwk = try self.publicJwk(encryption.publicKey.rawRepresentation)
                let keyId = "p256:" + (try RemoteControllerCodec.digest([
                    "signingPublicKeyJwk": signingJwk,
                    "encryptionPublicKeyJwk": encryptionJwk,
                ]))
                let identity: [String: Any] = [
                    "version": 1, "role": "controller", "ownerId": ownerId,
                    "deviceId": deviceId, "keyId": keyId, "displayName": displayName,
                    "platform": "ios", "signingPublicKeyJwk": signingJwk,
                    "encryptionPublicKeyJwk": encryptionJwk,
                    "createdAt": Int64(Date().timeIntervalSince1970 * 1_000),
                ]
                try self.store.save([
                    "version": 1, "identity": identity,
                    "signingPrivateKey": RemoteControllerCodec.base64url(signing.rawRepresentation),
                    "encryptionPrivateKey": RemoteControllerCodec.base64url(encryption.rawRepresentation),
                    "sessionSequences": [String: Any](),
                ], ownerId: ownerId, deviceId: deviceId)
                return identity
            }
        }
    }

    @objc public func createCommand(_ call: CAPPluginCall) {
        resolve(call) {
            try self.store.mutate {
                let ownerId = try self.requiredIdentifier(call, "ownerId")
                let controllerDeviceId = try self.requiredIdentifier(call, "controllerDeviceId")
                let identifiers = ["grantId", "sessionId", "controllerKeyId", "targetRuntimeId", "targetKeyId"]
                var input: [String: String] = [:]
                for name in identifiers { input[name] = try self.requiredIdentifier(call, name) }
                guard let revision = call.getInt("grantRevision"), revision >= 1,
                      let action = call.getString("action"), self.actions.contains(action),
                      let payload = call.options["payload"],
                      let targetJwk = call.getObject("targetEncryptionPublicKeyJwk") else {
                    throw RemoteControllerError.invalid("Remote command authority is invalid.")
                }
                _ = try RemoteControllerCodec.canonicalData(payload)
                guard var record = try self.store.load(ownerId: ownerId, deviceId: controllerDeviceId),
                      let identity = record["identity"] as? [String: Any],
                      identity["keyId"] as? String == input["controllerKeyId"],
                      let signingData = try? RemoteControllerCodec.decodeBase64url(record["signingPrivateKey"]),
                      let signing = try? P256.Signing.PrivateKey(rawRepresentation: signingData) else {
                    throw RemoteControllerError.unavailable("Controller identity is unavailable or changed.")
                }
                let binding: [String: Any] = [
                    "ownerId": ownerId, "grantId": input["grantId"]!, "grantRevision": revision,
                    "sessionId": input["sessionId"]!, "controllerDeviceId": controllerDeviceId,
                    "controllerKeyId": input["controllerKeyId"]!, "targetRuntimeId": input["targetRuntimeId"]!,
                    "targetKeyId": input["targetKeyId"]!,
                ]
                let bindingDigest = try RemoteControllerCodec.digest(binding)
                let requestDigest = try RemoteControllerCodec.digest(["action": action, "payload": payload])
                var sessions = record["sessionSequences"] as? [String: Any] ?? [:]
                let sessionId = input["sessionId"]!
                if let previous = sessions[sessionId] as? [String: Any],
                   previous["bindingDigest"] as? String == bindingDigest,
                   let pending = previous["pending"] as? [String: Any],
                   let command = pending["command"] as? [String: Any],
                   let envelope = pending["envelope"] as? [String: Any],
                   let commandId = pending["commandId"] as? String,
                   let expiresAt = pending["expiresAt"] as? NSNumber {
                    return [
                        "commandId": commandId, "expiresAt": expiresAt,
                        "command": command, "envelope": envelope,
                        "recoveredPending": pending["requestDigest"] as? String != requestDigest,
                        "bindingDigest": bindingDigest,
                    ]
                }
                let previous = sessions[sessionId] as? [String: Any]
                if previous == nil && sessions.count >= 256 {
                    throw RemoteControllerError.unavailable("Secure remote session capacity is exhausted.")
                }
                let sequence = previous?["bindingDigest"] as? String == bindingDigest
                    ? ((previous?["sequence"] as? NSNumber)?.intValue ?? 0) + 1 : 1
                let issuedAt = Int64(Date().timeIntervalSince1970 * 1_000)
                let commandId = UUID().uuidString.lowercased()
                var body = binding
                body["version"] = 1; body["commandId"] = commandId; body["sequence"] = sequence
                body["nonce"] = UUID().uuidString.lowercased(); body["issuedAt"] = issuedAt
                body["expiresAt"] = issuedAt + 60_000; body["action"] = action; body["payload"] = payload
                body["payloadDigest"] = try RemoteControllerCodec.digest(payload)
                let signature = try signing.signature(for: RemoteControllerCodec.canonicalData(body))
                let command: [String: Any] = [
                    "body": body, "signatureAlgorithm": "ECDSA-P256-SHA256",
                    "signature": RemoteControllerCodec.base64url(signature.derRepresentation),
                ]
                let envelope = try self.seal(command: command, body: body, targetJwk: targetJwk)
                let pending: [String: Any] = [
                    "requestDigest": requestDigest, "commandId": commandId,
                    "expiresAt": issuedAt + 60_000, "command": command, "envelope": envelope,
                ]
                sessions[sessionId] = ["bindingDigest": bindingDigest, "sequence": sequence, "pending": pending]
                record["sessionSequences"] = sessions
                try self.store.save(record, ownerId: ownerId, deviceId: controllerDeviceId)
                return [
                    "commandId": commandId, "expiresAt": issuedAt + 60_000,
                    "command": command, "envelope": envelope,
                    "recoveredPending": false, "bindingDigest": bindingDigest,
                ]
            }
        }
    }

    @objc public func acknowledgeEnqueue(_ call: CAPPluginCall) {
        resolve(call) {
            try self.store.mutate {
                let ownerId = try self.requiredIdentifier(call, "ownerId")
                let deviceId = try self.requiredIdentifier(call, "controllerDeviceId")
                let sessionId = try self.requiredIdentifier(call, "sessionId")
                let commandId = try self.requiredIdentifier(call, "commandId")
                let bindingDigest = try self.requiredString(call, "bindingDigest", max: 128)
                guard var record = try self.store.load(ownerId: ownerId, deviceId: deviceId),
                      var sessions = record["sessionSequences"] as? [String: Any],
                      let entry = sessions[sessionId] as? [String: Any],
                      let pending = entry["pending"] as? [String: Any] else { return ["acknowledged": false] }
                guard entry["bindingDigest"] as? String == bindingDigest,
                      pending["commandId"] as? String == commandId else {
                    throw RemoteControllerError.invalid("Remote enqueue acknowledgement does not match the pending command.")
                }
                sessions[sessionId] = ["bindingDigest": bindingDigest, "sequence": entry["sequence"]!]
                record["sessionSequences"] = sessions
                try self.store.save(record, ownerId: ownerId, deviceId: deviceId)
                return ["acknowledged": true]
            }
        }
    }

    @objc public func clearSessionState(_ call: CAPPluginCall) {
        resolve(call) {
            try self.store.mutate {
                let ownerId = try self.requiredIdentifier(call, "ownerId")
                let deviceId = try self.requiredIdentifier(call, "controllerDeviceId")
                let sessionId = try self.requiredIdentifier(call, "sessionId")
                guard var record = try self.store.load(ownerId: ownerId, deviceId: deviceId),
                      var sessions = record["sessionSequences"] as? [String: Any],
                      let entry = sessions[sessionId] as? [String: Any] else { return ["cleared": false] }
                guard entry["pending"] == nil else {
                    throw RemoteControllerError.invalid("A remote command is still awaiting enqueue acknowledgement.")
                }
                sessions.removeValue(forKey: sessionId); record["sessionSequences"] = sessions
                try self.store.save(record, ownerId: ownerId, deviceId: deviceId)
                return ["cleared": true]
            }
        }
    }

    @objc public func openResult(_ call: CAPPluginCall) {
        open(call, kind: "result") { message in
            guard let body = message["body"] as? [String: Any], let status = body["status"] as? String else {
                throw RemoteControllerError.invalid("Remote result plaintext is invalid.")
            }
            var output: [String: Any] = ["status": status]
            if let result = body["result"] { output["result"] = result }
            if let code = body["errorCode"] { output["errorCode"] = code }
            return output
        }
    }

    @objc public func openStartReceipt(_ call: CAPPluginCall) {
        open(call, kind: "start_receipt") { message in
            guard let body = message["body"] as? [String: Any],
                  let startedAt = body["startedAt"] as? NSNumber,
                  let executionId = body["executionId"] as? String else {
                throw RemoteControllerError.invalid("Remote start receipt plaintext is invalid.")
            }
            return ["startedAt": startedAt, "executionId": executionId]
        }
    }

    private func open(_ call: CAPPluginCall, kind: String, project: @escaping ([String: Any]) throws -> [String: Any]) {
        resolve(call) {
            let ownerId = try self.requiredIdentifier(call, "ownerId")
            let deviceId = try self.requiredIdentifier(call, "controllerDeviceId")
            guard let envelope = call.getObject("envelope"), envelope["messageKind"] as? String == kind,
                  self.validEnvelope(envelope, kind: kind),
                  let command = call.getObject("command"), self.validCommand(command),
                  let commandBody = command["body"] as? [String: Any],
                  let target = call.getObject("targetIdentity"), self.validTarget(target),
                  let record = try self.store.mutate({ try self.store.load(ownerId: ownerId, deviceId: deviceId) }),
                  let identity = record["identity"] as? [String: Any],
                  identity["keyId"] as? String == envelope["recipientKeyId"] as? String,
                  let privateData = try? RemoteControllerCodec.decodeBase64url(record["encryptionPrivateKey"]),
                  let privateKey = try? P256.KeyAgreement.PrivateKey(rawRepresentation: privateData),
                  self.equalBinding(envelope, commandBody),
                  envelope["senderKeyId"] as? String == commandBody["targetKeyId"] as? String,
                  envelope["recipientKeyId"] as? String == commandBody["controllerKeyId"] as? String else {
                throw RemoteControllerError.invalid("Remote result authority is invalid.")
            }
            let message = try self.decrypt(envelope: envelope, commandBody: commandBody, privateKey: privateKey)
            try self.verify(message: message, target: target, commandBody: commandBody)
            return try project(message)
        }
    }

    private func seal(command: [String: Any], body: [String: Any], targetJwk: [String: Any]) throws -> [String: Any] {
        let recipient = try P256.KeyAgreement.PublicKey(rawRepresentation: publicRaw(targetJwk))
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: recipient)
        var header = binding(from: body)
        header["algorithm"] = "ECDH-P256-HKDF-SHA256+A256GCM"; header["messageKind"] = "command"
        header["senderKeyId"] = body["controllerKeyId"]; header["recipientKeyId"] = body["targetKeyId"]
        header["messageDigest"] = try RemoteControllerCodec.digest(command)
        for key in ["sequence", "nonce", "issuedAt", "expiresAt"] { header[key] = body[key] }
        let aad = try RemoteControllerCodec.canonicalData(header)
        let salt = try randomData(count: 32); let nonceData = try randomData(count: 12)
        let info = Data(SHA256.hash(data: Data("eliza-remote-control-v1\0".utf8) + aad))
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt, sharedInfo: info, outputByteCount: 32)
        let nonce = try AES.GCM.Nonce(data: nonceData)
        let sealed = try AES.GCM.seal(RemoteControllerCodec.canonicalData(command), using: key, nonce: nonce, authenticating: aad)
        var envelope = header
        envelope["ephemeralPublicKeyJwk"] = try publicJwk(ephemeral.publicKey.rawRepresentation)
        envelope["salt"] = RemoteControllerCodec.base64url(salt); envelope["iv"] = RemoteControllerCodec.base64url(nonceData)
        envelope["ciphertext"] = RemoteControllerCodec.base64url(sealed.ciphertext + sealed.tag)
        return envelope
    }

    private func decrypt(envelope: [String: Any], commandBody: [String: Any], privateKey: P256.KeyAgreement.PrivateKey) throws -> [String: Any] {
        guard let ephemeralJwk = envelope["ephemeralPublicKeyJwk"] as? [String: Any] else {
            throw RemoteControllerError.invalid("Remote envelope key is invalid.")
        }
        let ephemeral = try P256.KeyAgreement.PublicKey(rawRepresentation: publicRaw(ephemeralJwk))
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: ephemeral)
        var header = binding(from: envelope)
        for key in ["algorithm", "messageKind", "senderKeyId", "recipientKeyId", "messageDigest"] { header[key] = envelope[key] }
        let aad = try RemoteControllerCodec.canonicalData(header)
        let salt = try RemoteControllerCodec.decodeBase64url(envelope["salt"])
        let iv = try RemoteControllerCodec.decodeBase64url(envelope["iv"])
        let combined = try RemoteControllerCodec.decodeBase64url(envelope["ciphertext"])
        guard combined.count > 16 else { throw RemoteControllerError.invalid("Remote ciphertext is invalid.") }
        let info = Data(SHA256.hash(data: Data("eliza-remote-control-v1\0".utf8) + aad))
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt, sharedInfo: info, outputByteCount: 32)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: combined.dropLast(16), tag: combined.suffix(16))
        let plaintext = try AES.GCM.open(box, using: key, authenticating: aad)
        guard let message = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
              try RemoteControllerCodec.digest(message) == envelope["messageDigest"] as? String,
              equalBinding(message["body"] as? [String: Any], commandBody) else {
            throw RemoteControllerError.invalid("Remote plaintext binding is invalid.")
        }
        return message
    }

    private func verify(message: [String: Any], target: [String: Any], commandBody: [String: Any]) throws {
        let commandDigest = try RemoteControllerCodec.digest(commandBody)
        guard let body = message["body"] as? [String: Any], equalBinding(body, commandBody),
              Set(message.keys) == ["body", "signatureAlgorithm", "signature"],
              message["signatureAlgorithm"] as? String == "ECDSA-P256-SHA256",
              let signatureData = try? RemoteControllerCodec.decodeBase64url(message["signature"]),
              let signature = try? P256.Signing.ECDSASignature(derRepresentation: signatureData),
              let jwk = target["signingPublicKeyJwk"] as? [String: Any],
              let publicKey = try? P256.Signing.PublicKey(rawRepresentation: publicRaw(jwk)),
              publicKey.isValidSignature(signature, for: try RemoteControllerCodec.canonicalData(body)),
              target["role"] as? String == "target", target["ownerId"] as? String == body["ownerId"] as? String,
              target["runtimeId"] as? String == body["targetRuntimeId"] as? String,
              target["keyId"] as? String == body["targetKeyId"] as? String,
              body["commandDigest"] as? String == commandDigest else {
            throw RemoteControllerError.invalid("Remote signature or command binding is invalid.")
        }
        if body["status"] != nil {
            guard let status = body["status"] as? String,
                  ["completed", "rejected", "cancelled", "execution_ambiguous"].contains(status),
                  Set(body.keys).isSubset(of: Set(bindingKeys + [
                      "commandDigest", "status", "executionId", "startedAt", "completedAt",
                      "result", "errorCode", "resultDigest",
                  ])),
                  let completedAt = body["completedAt"] as? NSNumber,
                  self.integer(completedAt, minimum: 0),
                  self.digest(body["resultDigest"]),
                  body["errorCode"] == nil || RemoteControllerStore.identifier(body["errorCode"]) else {
                throw RemoteControllerError.invalid("Remote result status is invalid.")
            }
            let executionId = body["executionId"]
            let startedAt = body["startedAt"]
            let hasExecution = RemoteControllerStore.identifier(executionId)
                && (startedAt as? NSNumber).map { self.integer($0, minimum: 0) } == true
            let hasNoExecution = executionId is NSNull && startedAt is NSNull
            guard (hasExecution || hasNoExecution), status == "rejected" || hasExecution,
                  !hasExecution || completedAt.int64Value >= (startedAt as! NSNumber).int64Value else {
                throw RemoteControllerError.invalid("Remote result execution metadata is invalid.")
            }
            var resultValue: [String: Any] = [:]
            if let result = body["result"] { resultValue["result"] = result }
            if let errorCode = body["errorCode"] { resultValue["errorCode"] = errorCode }
            let resultDigest = try RemoteControllerCodec.digest(resultValue)
            guard body["resultDigest"] as? String == resultDigest else {
                throw RemoteControllerError.invalid("Remote result digest is invalid.")
            }
        } else {
            guard let startedAt = body["startedAt"] as? NSNumber,
                  self.integer(startedAt, minimum: 0),
                  RemoteControllerStore.identifier(body["executionId"]),
                  body["status"] as? String == "started",
                  Set(body.keys) == Set(bindingKeys + ["status", "commandDigest", "executionId", "startedAt"]) else {
                throw RemoteControllerError.invalid("Remote start receipt is invalid.")
            }
        }
    }

    private var bindingKeys: [String] {
        [
            "version", "ownerId", "grantId", "grantRevision", "sessionId", "controllerDeviceId",
            "controllerKeyId", "targetRuntimeId", "targetKeyId", "commandId",
        ]
    }

    private func validBinding(_ value: [String: Any]) -> Bool {
        guard (value["version"] as? NSNumber)?.intValue == 1,
              let revision = value["grantRevision"] as? NSNumber,
              integer(revision, minimum: 1) else { return false }
        return bindingKeys.filter { $0 != "version" && $0 != "grantRevision" }
            .allSatisfy { RemoteControllerStore.identifier(value[$0]) }
    }

    private func validCommand(_ value: [String: Any]) -> Bool {
        guard Set(value.keys) == ["body", "signatureAlgorithm", "signature"],
              value["signatureAlgorithm"] as? String == "ECDSA-P256-SHA256",
              let signature = value["signature"] as? String, !signature.isEmpty, signature.count <= 512,
              let body = value["body"] as? [String: Any], validBinding(body),
              Set(body.keys) == Set(bindingKeys + [
                  "sequence", "nonce", "issuedAt", "expiresAt", "action", "payload", "payloadDigest",
              ]),
              let sequence = body["sequence"] as? NSNumber, integer(sequence, minimum: 1),
              RemoteControllerStore.identifier(body["nonce"]),
              let issuedAt = body["issuedAt"] as? NSNumber, integer(issuedAt, minimum: 0),
              let expiresAt = body["expiresAt"] as? NSNumber, integer(expiresAt, minimum: 0),
              expiresAt.int64Value > issuedAt.int64Value,
              expiresAt.int64Value - issuedAt.int64Value <= 60_000,
              let action = body["action"] as? String, actions.contains(action),
              let payload = body["payload"], digest(body["payloadDigest"]),
              (try? RemoteControllerCodec.digest(payload)) == body["payloadDigest"] as? String else { return false }
        return true
    }

    private func validEnvelope(_ value: [String: Any], kind: String) -> Bool {
        guard validBinding(value),
              Set(value.keys) == Set(bindingKeys + [
                  "algorithm", "messageKind", "senderKeyId", "recipientKeyId", "messageDigest",
                  "ephemeralPublicKeyJwk", "salt", "iv", "ciphertext",
              ]),
              value["algorithm"] as? String == "ECDH-P256-HKDF-SHA256+A256GCM",
              value["messageKind"] as? String == kind,
              RemoteControllerStore.identifier(value["senderKeyId"]),
              RemoteControllerStore.identifier(value["recipientKeyId"]),
              digest(value["messageDigest"]),
              let jwk = value["ephemeralPublicKeyJwk"] as? [String: Any],
              (try? publicRaw(jwk)) != nil,
              (try? RemoteControllerCodec.decodeBase64url(value["salt"]).count) == 32,
              (try? RemoteControllerCodec.decodeBase64url(value["iv"]).count) == 12,
              (try? RemoteControllerCodec.decodeBase64url(value["ciphertext"]).count).map({ $0 > 16 }) == true else {
            return false
        }
        return true
    }

    private func validTarget(_ value: [String: Any]) -> Bool {
        guard Set(value.keys) == [
            "version", "role", "ownerId", "runtimeId", "keyId", "displayName", "platform",
            "signingPublicKeyJwk", "encryptionPublicKeyJwk", "createdAt",
        ],
              (value["version"] as? NSNumber)?.intValue == 1,
              value["role"] as? String == "target",
              RemoteControllerStore.identifier(value["ownerId"]),
              RemoteControllerStore.identifier(value["runtimeId"]),
              RemoteControllerStore.identifier(value["keyId"]),
              RemoteControllerStore.displayName(value["displayName"]),
              ["ios", "macos", "windows", "linux", "android", "web"].contains(value["platform"] as? String),
              let signing = value["signingPublicKeyJwk"] as? [String: Any],
              let encryption = value["encryptionPublicKeyJwk"] as? [String: Any],
              (try? publicRaw(signing)) != nil, (try? publicRaw(encryption)) != nil,
              let createdAt = value["createdAt"] as? NSNumber, integer(createdAt, minimum: 0) else { return false }
        return true
    }

    private func integer(_ value: NSNumber, minimum: Int64) -> Bool {
        value.doubleValue.isFinite && value.doubleValue.rounded(.towardZero) == value.doubleValue
            && value.doubleValue <= 9_007_199_254_740_991 && value.int64Value >= minimum
    }

    private func digest(_ value: Any?) -> Bool {
        guard let value = value as? String else { return false }
        return value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    }

    private func binding(from value: [String: Any]) -> [String: Any] {
        var output: [String: Any] = [:]
        for key in bindingKeys {
            output[key] = value[key]
        }
        return output
    }

    private func equalBinding(_ left: [String: Any]?, _ right: [String: Any]?) -> Bool {
        guard let left, let right else { return false }
        return (try? RemoteControllerCodec.canonicalData(binding(from: left))) == (try? RemoteControllerCodec.canonicalData(binding(from: right)))
    }

    private func publicRaw(_ jwk: [String: Any]) throws -> Data {
        guard jwk["kty"] as? String == "EC", jwk["crv"] as? String == "P-256" else {
            throw RemoteControllerError.invalid("Remote P-256 public key is invalid.")
        }
        let x = try RemoteControllerCodec.decodeBase64url(jwk["x"]), y = try RemoteControllerCodec.decodeBase64url(jwk["y"])
        guard x.count == 32, y.count == 32 else { throw RemoteControllerError.invalid("Remote P-256 public key is invalid.") }
        return Data([0x04]) + x + y
    }

    private func publicJwk(_ raw: Data) throws -> [String: Any] {
        guard raw.count == 65, raw.first == 0x04 else { throw RemoteControllerError.invalid("Generated P-256 key is invalid.") }
        return ["kty": "EC", "crv": "P-256", "x": RemoteControllerCodec.base64url(raw[1..<33]), "y": RemoteControllerCodec.base64url(raw[33..<65])]
    }

    private func randomData(count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else {
            throw RemoteControllerError.unavailable("Secure random generation is unavailable.")
        }
        return Data(bytes)
    }

    private func requiredIdentifier(_ call: CAPPluginCall, _ name: String) throws -> String {
        guard let value = call.getString(name), RemoteControllerStore.identifier(value) else {
            throw RemoteControllerError.invalid("Remote controller \(name) is invalid.")
        }
        return value
    }

    private func requiredString(_ call: CAPPluginCall, _ name: String, max: Int) throws -> String {
        guard let value = call.getString(name)?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty, value.count <= max else {
            throw RemoteControllerError.invalid("Remote controller \(name) is invalid.")
        }
        return value
    }

    private func resolve(_ call: CAPPluginCall, operation: @escaping () throws -> [String: Any]) {
        DispatchQueue.global(qos: .userInitiated).async {
            do { call.resolve(try operation()) }
            // error-policy:J1 Capacitor is the native transport boundary.
            catch { call.reject(error.localizedDescription) }
        }
    }
}
