import Foundation
import JavaScriptCore

// MARK: - JSContext queue affinity

/// Thread/queue-affinity helpers for the JSContext-bound dispatch queue.
///
/// JSContext is single-threaded. The runtime owns a serial DispatchQueue
/// (`ai.eliza.bun.runtime`). All host-function bodies execute on that queue.
/// I/O bridges (HTTP fetch, llama generation) dispatch off the runtime queue
/// to do work, then post results back via a wrapper that re-enters the
/// JSContext queue.
public enum RuntimeQueue {
    public static let label = "ai.eliza.bun.runtime"

    /// Returns the JS thread's dispatch queue. Created lazily by the runtime
    /// at startup and stored here for the bridge modules to use.
    public static var current: DispatchQueue?

    /// Dispatches a block onto the JSContext queue. If the queue is not yet
    /// set up (e.g. early-bridge construction during install), runs inline.
    public static func dispatchOnJS(_ block: @escaping () -> Void) {
        if let q = current {
            q.async(execute: block)
        } else {
            block()
        }
    }
}

// MARK: - JSValue conveniences

public extension JSValue {
    /// Returns `true` when the value is `null` or `undefined`.
    var isNullish: Bool {
        return isNull || isUndefined
    }

    /// Bridges a `JSValue` Uint8Array (or ArrayBuffer) to a Swift `Data` blob.
    /// Returns `nil` if the value isn't a TypedArray / ArrayBuffer-backed view.
    func toData() -> Data? {
        guard let ctx = context else { return nil }

        // Common path: JSC exposes typed-array length via .length and per-element
        // access via subscript. That's slow for large blobs. Faster: call back
        // into JS to expose a byteLength + slice() to a Uint8Array, then walk
        // the byte values. We keep it portable across JSC builds without
        // relying on `JSObjectGetTypedArrayBytesPtr` which is gated by
        // availability flags.

        let lenValue = forProperty("length")
        guard let lenValue = lenValue, lenValue.isNumber else {
            return nil
        }
        let count = Int(lenValue.toInt32())
        if count == 0 { return Data() }

        let global = ctx.globalObject
        let helper = global?.forProperty("__milady_uint8_to_array")
        if helper == nil || helper?.isUndefined == true {
            let install = "globalThis.__milady_uint8_to_array = function(u){const o=new Array(u.length); for (let i=0;i<u.length;i++){o[i]=u[i]|0;} return o;};"
            ctx.evaluateScript(install)
        }

        guard let arrayValue = ctx.evaluateScript("globalThis.__milady_uint8_to_array")?
            .call(withArguments: [self]),
              let nsArray = arrayValue.toArray() else {
            return nil
        }
        var out = Data(count: nsArray.count)
        out.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            for (i, entry) in nsArray.enumerated() {
                let n = (entry as? NSNumber)?.uint8Value ?? 0
                base.storeBytes(of: n, toByteOffset: i, as: UInt8.self)
            }
        }
        return out
    }

    /// Returns a string array from a JS array of strings. Returns nil if not
    /// an array.
    func toStringArray() -> [String]? {
        guard isArray else { return nil }
        guard let arr = toArray() else { return nil }
        var out: [String] = []
        out.reserveCapacity(arr.count)
        for item in arr {
            if let s = item as? String {
                out.append(s)
            } else if let n = item as? NSNumber {
                out.append(n.stringValue)
            } else {
                out.append(String(describing: item))
            }
        }
        return out
    }

    /// Returns a [String: String] map from a JS object whose values are strings.
    func toStringMap() -> [String: String] {
        var out: [String: String] = [:]
        guard let obj = toObject() as? [String: Any] else { return out }
        for (k, v) in obj {
            if let s = v as? String {
                out[k] = s
            } else if let n = v as? NSNumber {
                out[k] = n.stringValue
            } else {
                out[k] = String(describing: v)
            }
        }
        return out
    }
}

public extension JSContext {
    /// Returns a fresh Uint8Array JSValue for the given Swift `Data`.
    func newUint8Array(_ data: Data) -> JSValue {
        // Constructing a Uint8Array directly from raw bytes through the public
        // JSC API requires either JSObjectMakeTypedArrayWithBytesNoCopy or
        // round-tripping through JS. We avoid the C API for portability.
        // Strategy: stash bytes in a JS Array of numbers, then convert via
        // Uint8Array.from().
        let helper = """
        (function(arr){return Uint8Array.from(arr);})
        """
        let factory = evaluateScript(helper)
        var ints: [Int] = []
        ints.reserveCapacity(data.count)
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            for i in 0..<data.count {
                let b = base.load(fromByteOffset: i, as: UInt8.self)
                ints.append(Int(b))
            }
        }
        let result = factory?.call(withArguments: [ints])
        return result ?? JSValue(undefinedIn: self)
    }

    /// Installs a host function on `globalThis.__MILADY_BRIDGE__[name]`.
    /// `body` runs on the JSContext queue (the caller's thread).
    func installBridgeFunction(name: String, _ body: @escaping ([JSValue]) -> Any?) {
        let block: @convention(block) () -> Any? = {
            let args = JSContext.currentArguments() as? [JSValue] ?? []
            return body(args)
        }
        let global = globalObject!
        var bridge = global.forProperty("__MILADY_BRIDGE__")
        if bridge == nil || bridge?.isUndefined == true || bridge?.isNull == true {
            evaluateScript("globalThis.__MILADY_BRIDGE__ = {};")
            bridge = global.forProperty("__MILADY_BRIDGE__")
        }
        bridge?.setObject(unsafeBitCast(block, to: AnyObject.self), forKeyedSubscript: name as NSString)
    }
}

// MARK: - Exception bridging

public struct JSRuntimeError: Error, CustomStringConvertible {
    public let message: String
    public let stack: String?

    public init(message: String, stack: String? = nil) {
        self.message = message
        self.stack = stack
    }

    public var description: String {
        if let s = stack, !s.isEmpty {
            return "\(message)\n\(s)"
        }
        return message
    }
}

public extension JSContext {
    /// Reads and clears the pending exception on the context. Returns a
    /// Swift error if one was present.
    func takeException() -> JSRuntimeError? {
        guard let exc = self.exception else { return nil }
        defer { self.exception = nil }
        let message = exc.toString() ?? "Unknown JS error"
        let stack = exc.objectForKeyedSubscript("stack")?.toString()
        return JSRuntimeError(message: message, stack: stack)
    }
}

// MARK: - JSManagedValue wrapper

/// Holds a JS callback function safely across Swift queue hops. JSManagedValue
/// is required because raw JSValue retention can deadlock the GC.
public final class ManagedCallback {
    public let managed: JSManagedValue
    public weak var context: JSContext?

    public init?(value: JSValue) {
        guard value.isObject else { return nil }
        self.context = value.context
        self.managed = JSManagedValue(value: value)
        // Hand the managed value to the VM so it survives GC sweeps.
        value.context?.virtualMachine.addManagedReference(self.managed, withOwner: self)
    }

    deinit {
        context?.virtualMachine.removeManagedReference(managed, withOwner: self)
    }

    /// Invokes the callback on the JSContext queue.
    public func call(args: [Any] = []) {
        RuntimeQueue.dispatchOnJS { [weak self] in
            guard let self = self else { return }
            guard let value = self.managed.value else { return }
            _ = value.call(withArguments: args)
        }
    }

    /// Synchronous-on-queue call, intended for use when already on the
    /// JSContext queue. Returns the call's JSValue result.
    @discardableResult
    public func callSync(args: [Any] = []) -> JSValue? {
        guard let value = managed.value else { return nil }
        return value.call(withArguments: args)
    }
}
