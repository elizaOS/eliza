import Foundation
import JavaScriptCore
import CryptoKit
import CommonCrypto

/// Implements the `crypto_*` host functions from `BRIDGE_CONTRACT.md`.
///
/// SHA/HMAC/AES-GCM go through CryptoKit. PBKDF2 falls through to
/// CommonCrypto's `CCKeyDerivationPBKDF` because CryptoKit doesn't expose
/// PBKDF2 directly.
public final class CryptoBridge {
    public init() {}

    public func install(into ctx: JSContext) {
        ctx.installBridgeFunction(name: "crypto_random_bytes") { args in
            guard let len = args.first?.toNumber()?.intValue, len > 0 else {
                return ctx.newUint8Array(Data())
            }
            var bytes = [UInt8](repeating: 0, count: len)
            let status = SecRandomCopyBytes(kSecRandomDefault, len, &bytes)
            if status != errSecSuccess {
                // Fall back to arc4random which can't fail.
                for i in 0..<len { bytes[i] = UInt8.random(in: 0...255) }
            }
            return ctx.newUint8Array(Data(bytes))
        }

        ctx.installBridgeFunction(name: "crypto_random_uuid") { _ in
            return UUID().uuidString.lowercased()
        }

        ctx.installBridgeFunction(name: "crypto_hash") { args in
            guard args.count >= 2,
                  let algo = args[0].toString(),
                  let data = args[1].toData() else {
                return NSNull()
            }
            let out = Self.hash(algo: algo, data: data)
            guard let out = out else { return NSNull() }
            return ctx.newUint8Array(out)
        }

        ctx.installBridgeFunction(name: "crypto_hmac") { args in
            guard args.count >= 3,
                  let algo = args[0].toString(),
                  let key = args[1].toData(),
                  let data = args[2].toData() else {
                return NSNull()
            }
            let out = Self.hmac(algo: algo, key: key, data: data)
            guard let out = out else { return NSNull() }
            return ctx.newUint8Array(out)
        }

        ctx.installBridgeFunction(name: "crypto_pbkdf2") { args in
            guard args.count >= 5,
                  let password = args[0].toData(),
                  let salt = args[1].toData(),
                  let iter = args[2].toNumber()?.uint32Value,
                  let keyLen = args[3].toNumber()?.intValue,
                  let digest = args[4].toString() else {
                return NSNull()
            }
            let out = Self.pbkdf2(
                password: password,
                salt: salt,
                iterations: iter,
                keyLength: keyLen,
                digest: digest
            )
            guard let out = out else { return NSNull() }
            return ctx.newUint8Array(out)
        }

        ctx.installBridgeFunction(name: "crypto_aes_gcm_encrypt") { args in
            guard args.count >= 3,
                  let key = args[0].toData(),
                  let nonce = args[1].toData(),
                  let plaintext = args[2].toData() else {
                return NSNull()
            }
            let aad: Data? = args.count >= 4 ? args[3].toData() : nil
            guard let sealed = Self.aesGcmEncrypt(key: key, nonce: nonce, plaintext: plaintext, aad: aad) else {
                return NSNull()
            }
            return [
                "ciphertext": ctx.newUint8Array(sealed.ciphertext),
                "tag": ctx.newUint8Array(sealed.tag),
            ] as [String: Any]
        }

        ctx.installBridgeFunction(name: "crypto_aes_gcm_decrypt") { args in
            guard args.count >= 4,
                  let key = args[0].toData(),
                  let nonce = args[1].toData(),
                  let ciphertext = args[2].toData(),
                  let tag = args[3].toData() else {
                return NSNull()
            }
            let aad: Data? = args.count >= 5 ? args[4].toData() : nil
            guard let plain = Self.aesGcmDecrypt(key: key, nonce: nonce, ciphertext: ciphertext, tag: tag, aad: aad) else {
                return NSNull()
            }
            return ctx.newUint8Array(plain)
        }
    }

    // MARK: - Hashes

    static func hash(algo: String, data: Data) -> Data? {
        switch algo.lowercased() {
        case "sha256":
            return Data(SHA256.hash(data: data))
        case "sha512":
            return Data(SHA512.hash(data: data))
        case "sha1":
            return Data(Insecure.SHA1.hash(data: data))
        case "md5":
            return Data(Insecure.MD5.hash(data: data))
        default:
            return nil
        }
    }

    static func hmac(algo: String, key: Data, data: Data) -> Data? {
        let symmetricKey = SymmetricKey(data: key)
        switch algo.lowercased() {
        case "sha256":
            let mac = HMAC<SHA256>.authenticationCode(for: data, using: symmetricKey)
            return Data(mac)
        case "sha512":
            let mac = HMAC<SHA512>.authenticationCode(for: data, using: symmetricKey)
            return Data(mac)
        case "sha1":
            let mac = HMAC<Insecure.SHA1>.authenticationCode(for: data, using: symmetricKey)
            return Data(mac)
        default:
            return nil
        }
    }

    static func pbkdf2(
        password: Data,
        salt: Data,
        iterations: UInt32,
        keyLength: Int,
        digest: String
    ) -> Data? {
        let prf: CCPseudoRandomAlgorithm
        switch digest.lowercased() {
        case "sha256": prf = CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256)
        case "sha512": prf = CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA512)
        case "sha1":   prf = CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1)
        default: return nil
        }

        var derived = Data(count: keyLength)
        let status = derived.withUnsafeMutableBytes { (derivedRaw: UnsafeMutableRawBufferPointer) -> Int32 in
            guard let derivedBase = derivedRaw.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
                return Int32(kCCParamError)
            }
            return password.withUnsafeBytes { (pwRaw: UnsafeRawBufferPointer) -> Int32 in
                guard let pwBase = pwRaw.baseAddress?.assumingMemoryBound(to: Int8.self) else {
                    return Int32(kCCParamError)
                }
                return salt.withUnsafeBytes { (saltRaw: UnsafeRawBufferPointer) -> Int32 in
                    guard let saltBase = saltRaw.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
                        return Int32(kCCParamError)
                    }
                    return CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        pwBase, password.count,
                        saltBase, salt.count,
                        prf,
                        iterations,
                        derivedBase, keyLength
                    )
                }
            }
        }
        if status != 0 { return nil }
        return derived
    }

    // MARK: - AES-GCM

    struct SealedBlob {
        let ciphertext: Data
        let tag: Data
    }

    static func aesGcmEncrypt(key: Data, nonce: Data, plaintext: Data, aad: Data?) -> SealedBlob? {
        guard key.count == 16 || key.count == 32 else { return nil }
        guard nonce.count == 12 else { return nil }
        let symmetric = SymmetricKey(data: key)
        guard let aesNonce = try? AES.GCM.Nonce(data: nonce) else { return nil }
        do {
            let sealed: AES.GCM.SealedBox
            if let aad = aad {
                sealed = try AES.GCM.seal(plaintext, using: symmetric, nonce: aesNonce, authenticating: aad)
            } else {
                sealed = try AES.GCM.seal(plaintext, using: symmetric, nonce: aesNonce)
            }
            return SealedBlob(ciphertext: sealed.ciphertext, tag: sealed.tag)
        } catch {
            return nil
        }
    }

    static func aesGcmDecrypt(key: Data, nonce: Data, ciphertext: Data, tag: Data, aad: Data?) -> Data? {
        guard key.count == 16 || key.count == 32 else { return nil }
        guard nonce.count == 12 else { return nil }
        let symmetric = SymmetricKey(data: key)
        guard let aesNonce = try? AES.GCM.Nonce(data: nonce),
              let sealed = try? AES.GCM.SealedBox(nonce: aesNonce, ciphertext: ciphertext, tag: tag) else {
            return nil
        }
        do {
            if let aad = aad {
                return try AES.GCM.open(sealed, using: symmetric, authenticating: aad)
            } else {
                return try AES.GCM.open(sealed, using: symmetric)
            }
        } catch {
            return nil
        }
    }
}

// MARK: - JSValue numeric helpers used by the bridge

extension JSValue {
    /// Returns a Swift NSNumber for numeric JSValues. Nil for non-numbers.
    func toNumber() -> NSNumber? {
        guard isNumber else { return nil }
        return NSNumber(value: toDouble())
    }
}
