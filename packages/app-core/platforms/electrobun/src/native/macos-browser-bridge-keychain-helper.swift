/**
 Owns the signed macOS Keychain operation that shares the browser enrollment
 HMAC key between the desktop app and Safari extension access group.
 */

import Foundation
import Security

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count == 10,
      arguments[1] == "get-or-create",
      arguments[2] == "--service",
      arguments[4] == "--account",
      arguments[6] == "--access-group",
      arguments[8] == "--bytes",
      arguments[9] == "32" else {
    fail("invalid invocation")
}

let service = arguments[3]
let account = arguments[5]
let accessGroup = arguments[7]
let teamId = accessGroup.split(separator: ".", maxSplits: 1).first.map(String.init) ?? ""
let validTeamId = teamId.count == 10 && teamId.unicodeScalars.allSatisfy {
    CharacterSet.uppercaseLetters.union(.decimalDigits).contains($0)
}
guard service == "ai.elizaos.browserbridge.native-enrollment",
      account == "native-enrollment-broker",
      validTeamId,
      accessGroup == "\(teamId).ai.elizaos.browserbridge.shared" else {
    fail("invalid Keychain identity")
}

let identity: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecAttrAccessGroup as String: accessGroup,
]
var query = identity
query[kSecReturnData as String] = true
query[kSecMatchLimit as String] = kSecMatchLimitOne
var result: CFTypeRef?
let readStatus = SecItemCopyMatching(query as CFDictionary, &result)
if readStatus == errSecSuccess {
    guard let secret = result as? Data, secret.count == 32 else {
        fail("invalid existing Keychain secret")
    }
    print(secret.base64EncodedString())
    exit(0)
}
guard readStatus == errSecItemNotFound else {
    fail("Keychain read failed: \(readStatus)")
}

var bytes = [UInt8](repeating: 0, count: 32)
guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
    fail("secure random generation failed")
}
let secret = Data(bytes)
var add = identity
add[kSecValueData as String] = secret
add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
let addStatus = SecItemAdd(add as CFDictionary, nil)
guard addStatus == errSecSuccess else {
    fail("Keychain creation failed: \(addStatus)")
}
print(secret.base64EncodedString())
