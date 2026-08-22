/**
 * Validates Safari native-enrollment messages and relays them to the authenticated
 * desktop broker through the containing app's private application-group socket.
 * Neither requests nor responses are logged because successful responses contain
 * bearer credentials.
 */
import CryptoKit
import Darwin
import Foundation
import SafariServices

private enum NativeEnrollmentConstants {
    static let protocolVersion = 1
    static let requestType = "browser_bridge.enroll"
    static let resultType = "browser_bridge.enroll_result"
    static let errorType = "browser_bridge.error"
    static let maximumMessageBytes = 65_536
    static let socketTimeoutSeconds = 3
    static let maximumPairingTokenLifetimeSeconds: TimeInterval = 300
    static let sharedSecretName = "s"
}

enum NativeEnrollmentError: Error {
    case unsupportedProtocol
    case invalidRequest
    case appNotAuthenticated
    case appNotRunning
    case brokerUnavailable

    var code: String {
        switch self {
        case .unsupportedProtocol:
            return "unsupported_version"
        case .invalidRequest, .brokerUnavailable:
            return "broker_unavailable"
        case .appNotAuthenticated:
            return "app_not_authenticated"
        case .appNotRunning:
            return "app_not_running"
        }
    }

    var retryable: Bool {
        code == "app_not_running" ||
            code == "app_not_authenticated" ||
            code == "broker_unavailable"
    }
}

struct ValidatedEnrollmentRequest {
    let requestId: String
    let nonce: String
    let extensionVersion: String
    let profileId: String
    let dictionary: [String: Any]
}

private struct SafariNativeConfiguration {
    let appGroup: String
    let socketName: String

    static func load() throws -> SafariNativeConfiguration {
        guard
            let appGroup = Bundle.main.object(forInfoDictionaryKey: "BrowserBridgeAppGroup") as? String,
            appGroup.hasPrefix("group."),
            let socketName = Bundle.main.object(forInfoDictionaryKey: "BrowserBridgeBrokerSocketName") as? String,
            !socketName.isEmpty,
            !socketName.contains("/")
        else {
            throw NativeEnrollmentError.brokerUnavailable
        }
        return SafariNativeConfiguration(
            appGroup: appGroup,
            socketName: socketName
        )
    }
}

private func isCanonicalUuid(_ value: String) -> Bool {
    value.range(
        of: #"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"#,
        options: [.regularExpression, .caseInsensitive]
    ) != nil
}

private enum NativeEnrollmentValidator {
    private static let allowedKeys: Set<String> = [
        "v",
        "type",
        "requestId",
        "nonce",
        "browser",
        "extensionId",
        "extensionVersion",
        "profileId",
    ]

    static func validate(_ message: Any?) throws -> ValidatedEnrollmentRequest {
        guard let dictionary = message as? [String: Any] else {
            throw NativeEnrollmentError.invalidRequest
        }
        guard JSONSerialization.isValidJSONObject(dictionary) else {
            throw NativeEnrollmentError.invalidRequest
        }
        let data = try JSONSerialization.data(withJSONObject: dictionary, options: [.sortedKeys])
        guard data.count <= NativeEnrollmentConstants.maximumMessageBytes else {
            throw NativeEnrollmentError.invalidRequest
        }
        guard Set(dictionary.keys) == allowedKeys else {
            throw NativeEnrollmentError.invalidRequest
        }
        guard
            dictionary["v"] as? Int == NativeEnrollmentConstants.protocolVersion,
            dictionary["type"] as? String == NativeEnrollmentConstants.requestType,
            dictionary["browser"] as? String == "safari"
        else {
            throw NativeEnrollmentError.unsupportedProtocol
        }
        guard
            let requestId = dictionary["requestId"] as? String,
            isCanonicalUuid(requestId)
        else {
            throw NativeEnrollmentError.invalidRequest
        }
        guard
            let profileId = dictionary["profileId"] as? String,
            isCanonicalUuid(profileId)
        else {
            throw NativeEnrollmentError.invalidRequest
        }
        guard
            let nonce = dictionary["nonce"] as? String,
            nonce.count == 43,
            decodeBase64Url(nonce)?.count == 32
        else {
            throw NativeEnrollmentError.invalidRequest
        }
        guard
            dictionary["extensionId"] as? String == SafariBrokerAuthentication.callerId
        else {
            throw NativeEnrollmentError.invalidRequest
        }
        guard
            let extensionVersion = dictionary["extensionVersion"] as? String,
            extensionVersion.range(
                of: #"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$"#,
                options: .regularExpression
            ) != nil,
            extensionVersion.utf8.count <= 64
        else {
            throw NativeEnrollmentError.invalidRequest
        }
        return ValidatedEnrollmentRequest(
            requestId: requestId,
            nonce: nonce,
            extensionVersion: extensionVersion,
            profileId: profileId,
            dictionary: dictionary
        )
    }

    private static func decodeBase64Url(_ value: String) -> Data? {
        guard value.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil else {
            return nil
        }
        var base64 = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder != 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }
        return Data(base64Encoded: base64)
    }
}

enum SafariBrokerAuthentication {
    static let protocolName = "eliza.browser-bridge.broker/v1"
    static let callerId = "ai.elizaos.browserbridge.app.Extension"

    static func canonicalData(
        request: ValidatedEnrollmentRequest,
        timestampMs: Int64
    ) throws -> Data {
        let fields: [String] = [
            protocolName,
            String(timestampMs),
            "safari",
            callerId,
            "1",
            NativeEnrollmentConstants.requestType,
            request.requestId,
            request.nonce,
            "safari",
            callerId,
            request.extensionVersion,
            request.profileId,
        ]
        guard let data = fields.joined(separator: "\n").data(using: .utf8) else {
            throw NativeEnrollmentError.brokerUnavailable
        }
        return data
    }

    static func mac(
        request: ValidatedEnrollmentRequest,
        timestampMs: Int64,
        secret: Data
    ) throws -> String {
        guard secret.count == 32 else {
            throw NativeEnrollmentError.appNotAuthenticated
        }
        let authenticationCode = HMAC<SHA256>.authenticationCode(
            for: try canonicalData(request: request, timestampMs: timestampMs),
            using: SymmetricKey(data: secret)
        )
        return Data(authenticationCode)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

enum DesktopBrokerRelay {
    fileprivate static func send(
        request: ValidatedEnrollmentRequest,
        configuration: SafariNativeConfiguration
    ) throws -> [String: Any] {
        guard
            let containerUrl = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: configuration.appGroup
            )
        else {
            throw NativeEnrollmentError.brokerUnavailable
        }
        let containerPath = containerUrl.path
        var containerMetadata = stat()
        guard
            lstat(containerPath, &containerMetadata) == 0,
            (containerMetadata.st_mode & S_IFMT) == S_IFDIR,
            containerMetadata.st_uid == getuid()
        else {
            throw NativeEnrollmentError.appNotAuthenticated
        }
        let socketPath = containerUrl.appendingPathComponent(configuration.socketName).path
        var socketMetadata = stat()
        guard
            lstat(socketPath, &socketMetadata) == 0,
            (socketMetadata.st_mode & S_IFMT) == S_IFSOCK,
            socketMetadata.st_uid == getuid(),
            (socketMetadata.st_mode & 0o777) == 0o600
        else {
            throw NativeEnrollmentError.appNotRunning
        }
        let credential = try readBrokerCredential(
            path: containerUrl.appendingPathComponent(NativeEnrollmentConstants.sharedSecretName).path
        )
        let timestampMs = Int64(Date().timeIntervalSince1970 * 1_000)
        let relayEnvelope: [String: Any] = [
            "protocol": SafariBrokerAuthentication.protocolName,
            "timestampMs": timestampMs,
            "caller": [
                "browser": "safari",
                "id": SafariBrokerAuthentication.callerId,
            ],
            "request": request.dictionary,
            "mac": try SafariBrokerAuthentication.mac(
                request: request,
                timestampMs: timestampMs,
                secret: credential
            ),
        ]
        let payload = try JSONSerialization.data(withJSONObject: relayEnvelope, options: [.sortedKeys])
        guard payload.count <= NativeEnrollmentConstants.maximumMessageBytes else {
            throw NativeEnrollmentError.invalidRequest
        }
        let responseData = try exchange(socketPath: socketPath, payload: payload)
        guard
            let response = try JSONSerialization.jsonObject(with: responseData) as? [String: Any]
        else {
            throw NativeEnrollmentError.brokerUnavailable
        }
        return try SafariNativeResponseValidator.validate(response, request: request)
    }

    static func readBrokerCredential(path: String, expectedUid: uid_t = getuid()) throws -> Data {
        var pathMetadata = stat()
        guard
            lstat(path, &pathMetadata) == 0,
            (pathMetadata.st_mode & S_IFMT) == S_IFREG,
            pathMetadata.st_uid == expectedUid,
            (pathMetadata.st_mode & 0o777) == 0o600,
            pathMetadata.st_size == 32
        else {
            throw NativeEnrollmentError.appNotAuthenticated
        }
        let descriptor = Darwin.open(path, O_RDONLY | O_NOFOLLOW)
        guard descriptor >= 0 else {
            throw NativeEnrollmentError.appNotAuthenticated
        }
        defer { Darwin.close(descriptor) }

        var descriptorMetadata = stat()
        guard
            fstat(descriptor, &descriptorMetadata) == 0,
            (descriptorMetadata.st_mode & S_IFMT) == S_IFREG,
            descriptorMetadata.st_dev == pathMetadata.st_dev,
            descriptorMetadata.st_ino == pathMetadata.st_ino,
            descriptorMetadata.st_uid == expectedUid,
            (descriptorMetadata.st_mode & 0o777) == 0o600,
            descriptorMetadata.st_size == 32
        else {
            throw NativeEnrollmentError.appNotAuthenticated
        }

        var credential = Data(count: 32)
        var offset = 0
        try credential.withUnsafeMutableBytes { bytes in
            guard let baseAddress = bytes.baseAddress else {
                throw NativeEnrollmentError.appNotAuthenticated
            }
            while offset < 32 {
                let count = Darwin.read(descriptor, baseAddress.advanced(by: offset), 32 - offset)
                if count < 0 && errno == EINTR {
                    continue
                }
                guard count > 0 else {
                    throw NativeEnrollmentError.appNotAuthenticated
                }
                offset += count
            }
        }
        var extraByte: UInt8 = 0
        let extraCount = Darwin.read(descriptor, &extraByte, 1)
        guard extraCount == 0 else {
            throw NativeEnrollmentError.appNotAuthenticated
        }
        return credential
    }

    private static func exchange(socketPath: String, payload: Data) throws -> Data {
        guard socketPath.utf8.count < MemoryLayout<sockaddr_un>.size - 2 else {
            throw NativeEnrollmentError.brokerUnavailable
        }
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else {
            throw NativeEnrollmentError.brokerUnavailable
        }
        defer { Darwin.close(descriptor) }

        var timeout = timeval(tv_sec: NativeEnrollmentConstants.socketTimeoutSeconds, tv_usec: 0)
        guard
            setsockopt(
                descriptor,
                SOL_SOCKET,
                SO_RCVTIMEO,
                &timeout,
                socklen_t(MemoryLayout.size(ofValue: timeout))
            ) == 0,
            setsockopt(
                descriptor,
                SOL_SOCKET,
                SO_SNDTIMEO,
                &timeout,
                socklen_t(MemoryLayout.size(ofValue: timeout))
            ) == 0
        else {
            throw NativeEnrollmentError.brokerUnavailable
        }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(socketPath.utf8) + [0]
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            destination.copyBytes(from: pathBytes)
        }
        let addressLength = socklen_t(MemoryLayout<sa_family_t>.size + pathBytes.count)
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, addressLength)
            }
        }
        guard connected == 0 else {
            throw NativeEnrollmentError.appNotRunning
        }

        var length = UInt32(payload.count).littleEndian
        let lengthData = withUnsafeBytes(of: &length) { Data($0) }
        try writeAll(descriptor: descriptor, data: lengthData)
        try writeAll(descriptor: descriptor, data: payload)
        let responseLengthData = try readExactly(descriptor: descriptor, count: 4)
        let responseLength = responseLengthData.withUnsafeBytes {
            UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self))
        }
        guard responseLength > 0, responseLength <= NativeEnrollmentConstants.maximumMessageBytes else {
            throw NativeEnrollmentError.brokerUnavailable
        }
        return try readExactly(descriptor: descriptor, count: Int(responseLength))
    }

    private static func writeAll(descriptor: Int32, data: Data) throws {
        var offset = 0
        try data.withUnsafeBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return }
            while offset < data.count {
                let written = Darwin.write(descriptor, baseAddress.advanced(by: offset), data.count - offset)
                guard written > 0 else {
                    throw NativeEnrollmentError.brokerUnavailable
                }
                offset += written
            }
        }
    }

    private static func readExactly(descriptor: Int32, count: Int) throws -> Data {
        var data = Data(count: count)
        var offset = 0
        try data.withUnsafeMutableBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return }
            while offset < count {
                let received = Darwin.read(descriptor, baseAddress.advanced(by: offset), count - offset)
                guard received > 0 else {
                    throw NativeEnrollmentError.brokerUnavailable
                }
                offset += received
            }
        }
        return data
    }
}

enum SafariNativeResponseValidator {
    static func validate(
        _ response: [String: Any],
        request: ValidatedEnrollmentRequest
    ) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
        guard data.count <= NativeEnrollmentConstants.maximumMessageBytes else {
            throw NativeEnrollmentError.brokerUnavailable
        }
        guard
            response["v"] as? Int == NativeEnrollmentConstants.protocolVersion,
            response["requestId"] as? String == request.requestId
        else {
            throw NativeEnrollmentError.brokerUnavailable
        }
        let type = response["type"] as? String
        if type == NativeEnrollmentConstants.resultType {
            let expectedKeys: Set<String> = [
                "v", "type", "requestId", "nonce", "issuedAt", "config",
            ]
            let expectedConfigKeys: Set<String> = [
                "apiBaseUrl",
                "companionId",
                "pairingToken",
                "pairingTokenExpiresAt",
                "browser",
                "profileId",
                "profileLabel",
                "label",
            ]
            guard
                Set(response.keys) == expectedKeys,
                response["nonce"] as? String == request.nonce,
                let issuedAt = response["issuedAt"] as? String,
                let issuedDate = CanonicalRfc3339.parse(issuedAt),
                let config = response["config"] as? [String: Any],
                Set(config.keys) == expectedConfigKeys,
                config["browser"] as? String == "safari",
                config["profileId"] as? String == request.profileId,
                let apiBaseUrl = config["apiBaseUrl"] as? String,
                let apiUrl = URL(string: apiBaseUrl),
                apiUrl.scheme == "http",
                ["localhost", "127.0.0.1", "::1"].contains(apiUrl.host ?? ""),
                apiUrl.user == nil,
                apiUrl.password == nil,
                apiUrl.path.isEmpty || apiUrl.path == "/",
                apiUrl.query == nil,
                apiUrl.fragment == nil,
                let companionId = config["companionId"] as? String,
                (1 ... 256).contains(companionId.utf8.count),
                let pairingToken = config["pairingToken"] as? String,
                (1 ... 4_096).contains(pairingToken.utf8.count),
                let pairingTokenExpiresAt = config["pairingTokenExpiresAt"] as? String,
                let pairingTokenExpiry = CanonicalRfc3339.parse(pairingTokenExpiresAt),
                pairingTokenExpiry > issuedDate,
                pairingTokenExpiry.timeIntervalSince(issuedDate)
                    <= NativeEnrollmentConstants.maximumPairingTokenLifetimeSeconds,
                let profileLabel = config["profileLabel"] as? String,
                (1 ... 256).contains(profileLabel.utf8.count),
                let label = config["label"] as? String,
                (1 ... 256).contains(label.utf8.count)
            else {
                throw NativeEnrollmentError.brokerUnavailable
            }
            return response
        }
        if type == NativeEnrollmentConstants.errorType {
            let expectedKeys: Set<String> = [
                "v", "type", "requestId", "code", "retryable",
            ]
            let allowedCodes: Set<String> = [
                "app_not_running",
                "app_not_authenticated",
                "revoked",
                "unsupported_version",
                "broker_unavailable",
            ]
            guard
                Set(response.keys) == expectedKeys,
                let code = response["code"] as? String,
                allowedCodes.contains(code),
                response["retryable"] is Bool
            else {
                throw NativeEnrollmentError.brokerUnavailable
            }
            return response
        }
        throw NativeEnrollmentError.brokerUnavailable
    }
}

private enum CanonicalRfc3339 {
    private static let shape = try! NSRegularExpression(
        pattern: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$"#
    )

    static func parse(_ value: String) -> Date? {
        let range = NSRange(value.startIndex ..< value.endIndex, in: value)
        guard shape.firstMatch(in: value, range: range)?.range == range else {
            return nil
        }
        let options: ISO8601DateFormatter.Options = value.contains(".")
            ? [.withInternetDateTime, .withFractionalSeconds]
            : [.withInternetDateTime]
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = options
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.date(from: value)
    }
}

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message: Any?
        if #available(macOS 11.0, *) {
            message = item?.userInfo?[SFExtensionMessageKey]
        } else {
            message = item?.userInfo?["message"]
        }

        DispatchQueue.global(qos: .userInitiated).async {
            let response: [String: Any]
            do {
                let request = try NativeEnrollmentValidator.validate(message)
                let configuration = try SafariNativeConfiguration.load()
                response = try DesktopBrokerRelay.send(
                    request: request,
                    configuration: configuration
                )
            } catch let error as NativeEnrollmentError {
                response = Self.errorResponse(error, message: message)
            } catch {
                response = Self.errorResponse(.brokerUnavailable, message: message)
            }
            let responseItem = NSExtensionItem()
            if #available(macOS 11.0, *) {
                responseItem.userInfo = [SFExtensionMessageKey: response]
            } else {
                responseItem.userInfo = ["message": response]
            }
            context.completeRequest(returningItems: [responseItem])
        }
    }

    private static func errorResponse(_ error: NativeEnrollmentError, message: Any?) -> [String: Any] {
        let dictionary = message as? [String: Any]
        let requestId = (dictionary?["requestId"] as? String).flatMap {
            isCanonicalUuid($0) ? $0 : nil
        }
        return [
            "v": NativeEnrollmentConstants.protocolVersion,
            "type": NativeEnrollmentConstants.errorType,
            "requestId": requestId ?? NSNull(),
            "code": error.code,
            "retryable": error.retryable,
        ]
    }
}
