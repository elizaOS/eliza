import Foundation
import Capacitor
import AVFoundation

/// Capacitor plugin shell.
///
/// Exposes the JS surface declared in `src/definitions.ts`:
///   - `start(opts)` — boot the runtime and load the agent bundle
///   - `sendMessage(opts)` — round-trip a chat message through the agent
///   - `getStatus()` — return ready / model / tokensPerSecond
///   - `stop()` — tear down the runtime
///   - `call({ method, args })` — invoke any `ui_register_handler` handler
///
/// The plugin delegates everything to `ElizaBunRuntime`, which owns the
/// JSContext on its dedicated serial dispatch queue.
@objc(ElizaBunRuntimePlugin)
public class ElizaBunRuntimePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ElizaBunRuntimePlugin"
    public let jsName = "ElizaBunRuntime"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendMessage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLocalTtsStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLocalTtsDiagnostics", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "synthesizeLocalTts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "call", returnType: CAPPluginReturnPromise),
    ]

    // Native-only smoke is intentionally separate from the WebView smoke key.
    // The WebView smoke exercises the production Capacitor call path; using the
    // same key here races two full Bun runtimes and PGlite rejects the duplicate
    // database owner.
    private static let fullBunSmokeRequestKey = "CapacitorStorage.eliza:ios-full-bun-native-smoke:request"
    private static let fullBunSmokeResultKey = "CapacitorStorage.eliza:ios-full-bun-native-smoke:result"
    private static let webFullBunSmokeRequestKey = "CapacitorStorage.eliza:ios-full-bun-smoke:request"
    private static let webFullBunSmokeResultKey = "CapacitorStorage.eliza:ios-full-bun-smoke:result"
    private static let webFullBunPrewarmResultKey = "CapacitorStorage.eliza:ios-full-bun-prewarm:result"
    private static let mobileRuntimeModeKey = "CapacitorStorage.eliza:mobile-runtime-mode"
    private static let fullBunSmokeEnvKey = "ELIZA_IOS_FULL_BUN_NATIVE_SMOKE"
    private static let webFullBunSmokeEnvKey = "ELIZA_IOS_FULL_BUN_WEB_SMOKE"
    private var runtime: ElizaBunRuntime?
    private var nativeSmokeStarted = false
    private var fullBunPrewarmStarted = false
    private var localTtsPlayers: [String: AVAudioPlayer] = [:]

    override public func load() {
        // Construct lazily on first start to avoid holding the JSVirtualMachine
        // when the app launches without the runtime.
        runtime = nil
        runNativeFullBunSmokeIfRequested()
        prewarmFullBunRuntimeIfRequested()
    }

    // MARK: - start

    @objc func start(_ call: CAPPluginCall) {
        let bundlePath = call.getString("bundlePath")
        let polyfillPath = call.getString("polyfillPath")
        let engine = call.getString("engine") ?? IosRuntimePolicy.defaultEngine
        let argv = call.getArray("argv", String.self) ?? ["bun", "public/agent/agent-bundle.js"]
        let env: [String: String]
        if let raw = call.getObject("env") {
            env = raw.compactMapValues { $0 as? String }
        } else {
            env = [:]
        }

        let startedAt = Date()
        NSLog("[ElizaBunRuntimePlugin] start requested engine=\(engine) bundlePath=\(bundlePath ?? "default") argv=\(argv) envKeys=\(env.keys.sorted())")
        ElizaBunRuntimeBootTrace.post(stage: "engine-plugin-start-requested", detail: [
            "engine": engine,
        ])
        let runtime = ensureRuntime()
        runtime.start(
            bundlePath: bundlePath,
            polyfillPath: polyfillPath,
            engine: engine,
            argv: argv,
            env: env
        ) { result in
            let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
            switch result {
            case .success(let outcome):
                NSLog("[ElizaBunRuntimePlugin] start succeeded engine=\(engine) bridgeVersion=\(outcome.bridgeVersion) durationMs=\(durationMs)")
                ElizaBunRuntimeBootTrace.post(stage: "engine-plugin-start-ok", detail: [
                    "engine": engine,
                    "bridgeVersion": outcome.bridgeVersion,
                    "durationMs": durationMs,
                ])
                self.runNativeFullBunSmokeAfterSuccessfulStartIfRequested(runtime: runtime)
                DispatchQueue.main.async {
                    call.resolve([
                        "ok": true,
                        "bridgeVersion": outcome.bridgeVersion,
                    ])
                }
            case .failure(let error):
                NSLog("[ElizaBunRuntimePlugin] start failed engine=\(engine) durationMs=\(durationMs) error=\(error)")
                ElizaBunRuntimeBootTrace.post(stage: "engine-plugin-start-failed", detail: [
                    "engine": engine,
                    "durationMs": durationMs,
                    "error": "\(error)",
                ])
                DispatchQueue.main.async {
                    call.resolve([
                        "ok": false,
                        "error": "\(error)",
                    ])
                }
            }
        }
    }

    // MARK: - sendMessage

    @objc func sendMessage(_ call: CAPPluginCall) {
        guard let runtime = runtime else {
            call.reject("ElizaBunRuntime is not started")
            return
        }
        guard let message = call.getString("message") else {
            call.reject("sendMessage requires a message string")
            return
        }
        let conversationId = call.getString("conversationId")
        runtime.sendMessage(text: message, conversationId: conversationId) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let reply):
                    call.resolve(["reply": reply])
                case .failure(let error):
                    call.reject("\(error)")
                }
            }
        }
    }

    // MARK: - getStatus

    @objc func getStatus(_ call: CAPPluginCall) {
        guard let runtime = runtime else {
            call.resolve(["ready": false])
            return
        }
        runtime.currentStatus { status in
            DispatchQueue.main.async {
                var payload: JSObject = [
                    "ready": status.ready,
                    "engine": status.engine,
                ]
                if let v = status.bridgeVersion { payload["bridgeVersion"] = v }
                if let m = status.model { payload["model"] = m }
                if let tps = status.tokensPerSecond { payload["tokensPerSecond"] = tps }
                call.resolve(payload)
            }
        }
    }

    // MARK: - stop

    @objc func stop(_ call: CAPPluginCall) {
        guard let runtime = runtime else {
            call.resolve()
            return
        }
        runtime.stop {
            DispatchQueue.main.async {
                call.resolve()
            }
        }
    }

    @objc func getLocalTtsStatus(_ call: CAPPluginCall) {
#if ELIZA_IOS_INCLUDE_LLAMA
        guard let bundle = resolveLocalTtsBundleDir(override: call.getString("bundleDir")) else {
            call.resolve([
                "ready": false,
                "status": "missing",
                "message": "Eliza-1 voice assets are not installed in this iOS build.",
            ])
            return
        }
        call.resolve([
            "ready": true,
            "status": "assets-ready",
            "message": "Local voice assets are installed. Voice engine will warm on first playback.",
            "bundleDir": bundle.path,
            "modelId": modelId(for: bundle),
        ])
#else
        call.resolve([
            "ready": false,
            "status": "unavailable",
            "message": "This build is missing the iOS local voice playback engine.",
        ])
#endif
    }

    @objc func getLocalTtsDiagnostics(_ call: CAPPluginCall) {
#if ELIZA_IOS_INCLUDE_LLAMA
        let probe = call.getBool("probe") ?? false
        let playProbe = call.getBool("play") ?? Self.envFlag("ELIZA_IOS_TTS_PLAY_SMOKE")
        let keepProbeAudio = call.getBool("keepAudio") ?? Self.envFlag("ELIZA_IOS_TTS_KEEP_PROBE_AUDIO")
        let text = call.getString("text") ?? "Hi from Eliza."
        let bundleOverride = call.getString("bundleDir")
        let baseDiagnostics = buildLocalTtsDiagnostics(bundleOverride: bundleOverride)
        guard probe, let bundlePath = baseDiagnostics["selectedBundleDir"] as? String else {
            NSLog("[ElizaBunRuntimePlugin] Local TTS diagnostics \(baseDiagnostics)")
            call.resolve(baseDiagnostics)
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            var diagnostics = baseDiagnostics
            let result = LlamaBridgeImpl.shared.synthesizeSpeech(
                bundleDir: bundlePath,
                text: text,
                speakerPresetId: nil,
                maxSamples: 24_000 * 20
            )
            var probePayload: JSObject = [
                "ok": result.error == nil,
                "sampleRate": result.sampleRate,
                "samples": result.samples,
                "durationMs": result.durationMs,
            ]
            if let error = result.error {
                probePayload["error"] = error
            }
            if let audioFilePath = result.audioFilePath, !audioFilePath.isEmpty {
                probePayload["audioFilePath"] = audioFilePath
                let audioFileUrl = URL(fileURLWithPath: audioFilePath)
                if playProbe {
                    do {
                        let audioData = try Data(contentsOf: audioFileUrl)
                        try self.playLocalTtsAudio(audioData)
                        probePayload["played"] = true
                    } catch {
                        probePayload["played"] = false
                        probePayload["playError"] = error.localizedDescription
                    }
                }
                if !keepProbeAudio {
                    try? FileManager.default.removeItem(at: audioFileUrl)
                }
            }
            diagnostics["probe"] = probePayload
            diagnostics["engine"] = self.jsObject(LlamaBridgeImpl.shared.ttsEngineDiagnostics(bundleDir: bundlePath))
            NSLog("[ElizaBunRuntimePlugin] Local TTS diagnostics \(diagnostics)")
            DispatchQueue.main.async {
                call.resolve(diagnostics)
            }
        }
#else
        call.resolve([
            "available": false,
            "message": "This build is missing the iOS local voice playback engine.",
        ])
#endif
    }

    @objc func synthesizeLocalTts(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            call.reject("synthesizeLocalTts requires text")
            return
        }
#if ELIZA_IOS_INCLUDE_LLAMA
        guard let bundle = resolveLocalTtsBundleDir(override: call.getString("bundleDir")) else {
            call.reject("Eliza-1 voice assets are not installed in this iOS build.")
            return
        }
        let speakerPresetId = call.getString("speakerPresetId")
            ?? call.getString("voice")
            ?? call.getString("voiceId")
        let maxSamples = call.getDouble("maxSamples").map { Int($0) } ?? 24_000 * 60
        let playImmediately = call.getBool("play") ?? false
        DispatchQueue.global(qos: .userInitiated).async {
            let result = LlamaBridgeImpl.shared.synthesizeSpeech(
                bundleDir: bundle.path,
                text: text,
                speakerPresetId: speakerPresetId,
                maxSamples: maxSamples
            )
            if let error = result.error {
                DispatchQueue.main.async {
                    call.reject(error)
                }
                return
            }
            let audioBase64: String
            var audioDataForPlayback: Data?
            if let audioFilePath = result.audioFilePath, !audioFilePath.isEmpty {
                let audioFileUrl = URL(fileURLWithPath: audioFilePath)
                do {
                    let audioData = try Data(contentsOf: audioFileUrl)
                    audioDataForPlayback = audioData
                    audioBase64 = playImmediately ? "" : audioData.base64EncodedString()
                    try? FileManager.default.removeItem(at: audioFileUrl)
                } catch {
                    DispatchQueue.main.async {
                        call.reject("Failed to read synthesized audio: \(error.localizedDescription)")
                    }
                    return
                }
            } else {
                audioBase64 = result.audioBase64
                if playImmediately, let decoded = Data(base64Encoded: result.audioBase64) {
                    audioDataForPlayback = decoded
                }
            }
            DispatchQueue.main.async {
                if playImmediately {
                    do {
                        try self.playLocalTtsAudio(audioDataForPlayback)
                    } catch {
                        call.reject("Failed to play synthesized audio: \(error.localizedDescription)")
                        return
                    }
                }
                call.resolve([
                    "audioBase64": audioBase64,
                    "contentType": result.contentType,
                    "sampleRate": result.sampleRate,
                    "samples": result.samples,
                    "durationMs": result.durationMs,
                    "modelId": self.modelId(for: bundle),
                    "played": playImmediately,
                ])
            }
        }
#else
        call.reject("This build is missing the iOS local voice playback engine.")
#endif
    }

    private func playLocalTtsAudio(_ audioData: Data?) throws {
        guard let audioData, !audioData.isEmpty else {
            throw NSError(
                domain: "ElizaBunRuntime",
                code: -40,
                userInfo: [NSLocalizedDescriptionKey: "No synthesized audio data was available."]
            )
        }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try session.setActive(true)
        let player = try AVAudioPlayer(data: audioData)
        player.prepareToPlay()
        player.volume = 1.0
        let playerId = UUID().uuidString
        localTtsPlayers[playerId] = player
        guard player.play() else {
            localTtsPlayers.removeValue(forKey: playerId)
            throw NSError(
                domain: "ElizaBunRuntime",
                code: -41,
                userInfo: [NSLocalizedDescriptionKey: "AVAudioPlayer refused to start playback."]
            )
        }
        let cleanupDelay = max(1.0, player.duration + 1.0)
        DispatchQueue.main.asyncAfter(deadline: .now() + cleanupDelay) { [weak self] in
            self?.localTtsPlayers.removeValue(forKey: playerId)
        }
    }

    // MARK: - call

    @objc func call(_ pluginCall: CAPPluginCall) {
        guard let runtime = runtime else {
            pluginCall.reject("ElizaBunRuntime is not started")
            return
        }
        guard let method = pluginCall.getString("method") else {
            pluginCall.reject("call requires a method name")
            return
        }
        let args: Any? = pluginCall.getValue("args")
        runtime.dispatchHandler(method: method, args: args) { (result: Result<Any?, Error>) in
            DispatchQueue.main.async {
                switch result {
                case .success(let value):
                    pluginCall.resolve(["result": Self.jsonSafe(value)])
                case .failure(let error):
                    pluginCall.reject("\(error)")
                }
            }
        }
    }

    // MARK: - Helpers

    private func ensureRuntime() -> ElizaBunRuntime {
        if let existing = runtime { return existing }
        NSLog("[ElizaBunRuntimePlugin] creating ElizaBunRuntime")
        let new = ElizaBunRuntime(plugin: self)
        runtime = new
        return new
    }

    private struct LocalTtsBundleResolution {
        let override: URL?
        let roots: [URL]
        let selectedBundle: URL?
    }

    private func resolveLocalTtsBundleDir(override: String?) -> URL? {
        resolveLocalTtsBundleResolution(override: override).selectedBundle
    }

    private func resolveLocalTtsBundleResolution(override: String?) -> LocalTtsBundleResolution {
        if let override, !override.isEmpty {
            let url = URL(fileURLWithPath: override, isDirectory: true)
            if hasKokoroBundle(url) {
                return LocalTtsBundleResolution(override: url, roots: localTtsSearchRoots(), selectedBundle: url)
            }
        }
        let fm = FileManager.default
        let roots = localTtsSearchRoots()
        for root in roots where fm.fileExists(atPath: root.path) {
            if let bundle = findKokoroBundle(in: root) {
                return LocalTtsBundleResolution(
                    override: override.map { URL(fileURLWithPath: $0, isDirectory: true) },
                    roots: roots,
                    selectedBundle: bundle
                )
            }
        }
        return LocalTtsBundleResolution(
            override: override.map { URL(fileURLWithPath: $0, isDirectory: true) },
            roots: roots,
            selectedBundle: nil
        )
    }

    private func localTtsSearchRoots() -> [URL] {
        let paths = SandboxPaths()
        return [
            paths.appSupport
                .appendingPathComponent("local-inference", isDirectory: true)
                .appendingPathComponent("models", isDirectory: true),
            paths.bundle
                .appendingPathComponent("public", isDirectory: true)
                .appendingPathComponent("agent", isDirectory: true)
                .appendingPathComponent("models", isDirectory: true),
        ]
    }

    private func buildLocalTtsDiagnostics(bundleOverride: String?) -> JSObject {
        let fm = FileManager.default
        let resolution = resolveLocalTtsBundleResolution(override: bundleOverride)
        var payload: JSObject = [
            "available": resolution.selectedBundle != nil,
            "roots": resolution.roots.map { describeDirectory($0) },
            "engine": jsObject(LlamaBridgeImpl.shared.ttsEngineDiagnostics(bundleDir: resolution.selectedBundle?.path)),
        ]
        if let override = resolution.override {
            payload["override"] = describeDirectory(override)
        }
        guard let bundle = resolution.selectedBundle else {
            payload["message"] = "No bundled Kokoro local TTS assets were found."
            return payload
        }

        payload["selectedBundleDir"] = bundle.path
        payload["modelId"] = modelId(for: bundle)
        payload["ttsDir"] = describeDirectory(bundle.appendingPathComponent("tts", isDirectory: true))
        payload["files"] = [
            "kokoroCoreMlModel": describeFile(bundle.appendingPathComponent("tts/kokoro-coreml/kokoro_5s.mlmodelc", isDirectory: true)),
            "kokoroCoreMlVoice": describeFile(bundle.appendingPathComponent("tts/kokoro-coreml/voices/af_heart.json")),
            "kokoroGgufModel": describeFile(bundle.appendingPathComponent("tts/kokoro/kokoro-82m-v1_0-Q4_K_M.gguf")),
            "kokoroGgufVoice": describeFile(bundle.appendingPathComponent("tts/kokoro/voices/af_bella.bin")),
            "legacyOmniVoiceBase": describeFile(bundle.appendingPathComponent("tts/omnivoice-base-Q4_K_M.gguf")),
            "legacyOmniVoiceTokenizer": describeFile(bundle.appendingPathComponent("tts/omnivoice-tokenizer-Q4_K_M.gguf")),
            "text": describeFile(bundle.appendingPathComponent("text/eliza-1-2b-128k.gguf")),
            "asr": describeFile(bundle.appendingPathComponent("asr/eliza-1-asr.gguf")),
            "manifest": describeFile(bundle.appendingPathComponent("eliza-1.manifest.json")),
        ]
        let ttsDir = bundle.appendingPathComponent("tts", isDirectory: true)
        if let enumerator = fm.enumerator(
            at: ttsDir,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) {
            var ggufFiles: [JSObject] = []
            for case let url as URL in enumerator {
                let values = try? url.resourceValues(forKeys: [.isRegularFileKey])
                guard values?.isRegularFile == true, url.pathExtension.lowercased() == "gguf" else {
                    continue
                }
                ggufFiles.append(describeFile(url))
            }
            payload["ttsGgufFiles"] = ggufFiles
        }
        return payload
    }

    private func describeDirectory(_ url: URL) -> JSObject {
        let fm = FileManager.default
        var isDirectory: ObjCBool = false
        let exists = fm.fileExists(atPath: url.path, isDirectory: &isDirectory)
        return [
            "path": url.path,
            "exists": exists,
            "isDirectory": exists && isDirectory.boolValue,
            "readable": fm.isReadableFile(atPath: url.path),
        ]
    }

    private func describeFile(_ url: URL) -> JSObject {
        let fm = FileManager.default
        var payload: JSObject = [
            "path": url.path,
            "name": url.lastPathComponent,
            "exists": fm.fileExists(atPath: url.path),
            "readable": fm.isReadableFile(atPath: url.path),
        ]
        if let attrs = try? fm.attributesOfItem(atPath: url.path),
           let size = attrs[.size] as? NSNumber {
            payload["bytes"] = size
        }
        return payload
    }

    private static func envFlag(_ name: String) -> Bool {
        guard let raw = ProcessInfo.processInfo.environment[name]?.lowercased() else {
            return false
        }
        return raw == "1" || raw == "true" || raw == "yes" || raw == "on"
    }

    private func jsObject(_ dict: [String: Any]) -> JSObject {
        var payload: JSObject = [:]
        for (key, value) in dict {
            payload[key] = jsValue(value)
        }
        return payload
    }

    private func jsValue(_ value: Any) -> JSValue {
        switch value {
        case let value as String:
            return value
        case let value as Bool:
            return value
        case let value as Int:
            return value
        case let value as Int64:
            return NSNumber(value: value)
        case let value as UInt64:
            return NSNumber(value: value)
        case let value as Float:
            return value
        case let value as Double:
            return value
        case let value as NSNumber:
            return value
        case let value as [String: Any]:
            return jsObject(value)
        case let value as [Any]:
            return value.map { jsValue($0) }
        default:
            return String(describing: value)
        }
    }

    private func findKokoroBundle(in root: URL) -> URL? {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return nil
        }
        for case let url as URL in enumerator {
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey])
            guard values?.isDirectory == true, url.pathExtension == "bundle" else {
                continue
            }
            if hasKokoroBundle(url) { return url }
        }
        return nil
    }

    private func hasKokoroBundle(_ bundle: URL) -> Bool {
        let coreMlDir = bundle
            .appendingPathComponent("tts", isDirectory: true)
            .appendingPathComponent("kokoro-coreml", isDirectory: true)
        let fm = FileManager.default
        let model = coreMlDir.appendingPathComponent("kokoro_5s.mlmodelc", isDirectory: true)
        let voice = coreMlDir
            .appendingPathComponent("voices", isDirectory: true)
            .appendingPathComponent("af_heart.json")
        return fm.fileExists(atPath: model.path) && fm.fileExists(atPath: voice.path)
    }

    private func modelId(for bundle: URL) -> String {
        bundle.deletingPathExtension().lastPathComponent
    }

    // MARK: - Simulator full Bun smoke

    private func fullBunLaunchEnvironment(isSmoke: Bool) -> [String: String] {
        var env: [String: String] = [
            "ELIZA_PLATFORM": "ios",
            "ELIZA_MOBILE_PLATFORM": "ios",
            "ELIZA_RUNTIME_MODE": IosRuntimePolicy.safeLocalExecutionMode,
            "RUNTIME_MODE": IosRuntimePolicy.safeLocalExecutionMode,
            "LOCAL_RUNTIME_MODE": IosRuntimePolicy.safeLocalExecutionMode,
            "ELIZA_IOS_LOCAL_BACKEND": "1",
            "ELIZA_IOS_BUN_STARTUP_TIMEOUT_MS": "60000",
            "ELIZA_PGLITE_DISABLE_EXTENSIONS": "0",
            "ELIZA_VAULT_BACKEND": "file",
            "ELIZA_DISABLE_VAULT_PROFILE_RESOLVER": "1",
            "ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP": "1",
            "ELIZA_HEADLESS": "1",
            "ELIZA_IOS_BRIDGE_TRANSPORT": "bun-host-ipc",
            "LOG_LEVEL": "error",
        ]
        if isSmoke {
            env["ELIZA_IOS_FULL_BUN_SMOKE"] = "1"
        }
        // Pass through opt-in diagnostic toggles set on the launch environment
        // (e.g. via `devicectl process launch --environment-variables`) so a
        // headless prewarm boot can run the on-device model-grind self-test.
        for key in ["ELIZA_IOS_RUN_MODEL_GRIND"] {
            if let value = ProcessInfo.processInfo.environment[key], !value.isEmpty {
                env[key] = value
            }
        }
        return IosRuntimePolicy.sanitizeEnvironment(env)
    }

    private func prewarmFullBunRuntimeIfRequested() {
        guard !nativeSmokeStarted, !fullBunPrewarmStarted else { return }

        let defaults = UserDefaults.standard
        let webSmokeRequested =
            ProcessInfo.processInfo.environment[Self.webFullBunSmokeEnvKey] == "1" ||
            defaults.string(forKey: Self.webFullBunSmokeRequestKey) == "1"
        guard webSmokeRequested else { return }

        fullBunPrewarmStarted = true
        let runtime = ensureRuntime()
        if webSmokeRequested {
            writeWebFullBunSmokeProgress([
                "phase": "native-prewarm-starting",
                "nativePrewarm": true,
            ])
        }
        runtime.start(
            bundlePath: nil,
            polyfillPath: nil,
            engine: "bun",
            argv: ["bun", "--no-install", "public/agent/agent-bundle.js", "ios-bridge", "--stdio"],
            env: fullBunLaunchEnvironment(isSmoke: webSmokeRequested)
        ) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success:
                if webSmokeRequested {
                    self.writeWebFullBunSmokeProgress([
                        "phase": "native-prewarm-started",
                        "nativePrewarm": true,
                    ])
                    self.pollWebFullBunPrewarmReady(runtime: runtime, startedAt: Date(), attempt: 0)
                }
            case .failure(let error):
                self.fullBunPrewarmStarted = false
                if webSmokeRequested {
                    self.writeWebFullBunSmokeProgress([
                        "ok": false,
                        "phase": "failed",
                        "nativePrewarm": true,
                        "error": "\(error)",
                    ])
                } else {
                    NSLog("[ElizaBunRuntime] iOS full Bun prewarm failed: \(error)")
                }
            }
        }
    }

    private func runNativeFullBunSmokeIfRequested() {
        guard shouldRunNativeFullBunSmoke() else { return }
        nativeSmokeStarted = true

        let runtime = ensureRuntime()
        writeFullBunSmokeResult([
            "phase": "native-starting",
            "nativeOnly": true,
        ])
        runtime.start(
            bundlePath: nil,
            polyfillPath: nil,
            engine: "bun",
            argv: ["bun", "--no-install", "public/agent/agent-bundle.js", "ios-bridge", "--stdio"],
            env: fullBunLaunchEnvironment(isSmoke: true)
        ) { [weak self, weak runtime] result in
            guard let self = self, let runtime = runtime else { return }
            switch result {
            case .success:
                self.runNativeFullBunRouteSmoke(runtime: runtime)
            case .failure(let error):
                self.writeFullBunSmokeFailure(error)
            }
        }
    }

    private func pollWebFullBunPrewarmReady(
        runtime: ElizaBunRuntime,
        startedAt: Date,
        attempt: Int
    ) {
        dispatchSmokeCall(runtime: runtime, method: "status", args: ["timeoutMs": 5_000]) { [weak self, weak runtime] statusResult in
            guard let self = self, let runtime = runtime else { return }
            let elapsedMs = Int(Date().timeIntervalSince(startedAt) * 1000)
            switch statusResult {
            case .failure(let error):
                if elapsedMs >= 300_000 {
                    self.writeWebFullBunSmokeProgress([
                        "ok": false,
                        "phase": "failed",
                        "nativePrewarm": true,
                        "error": error.localizedDescription,
                        "finishedAt": self.isoTimestamp(),
                    ])
                    return
                }
                self.writeWebFullBunSmokeProgress([
                    "phase": "native-prewarm-waiting-backend",
                    "nativePrewarm": true,
                    "elapsedMs": elapsedMs,
                    "attempt": attempt,
                    "lastStatusError": error.localizedDescription,
                ])
                self.scheduleWebFullBunPrewarmReadyPoll(runtime: runtime, startedAt: startedAt, attempt: attempt + 1)
            case .success(let bridgeStatus):
                if self.isBridgeStatusReady(bridgeStatus) {
                    self.writeWebFullBunSmokeProgress([
                        "phase": "native-prewarm-ready",
                        "nativePrewarm": true,
                        "elapsedMs": elapsedMs,
                        "attempt": attempt,
                        "engine": runtime.engineMode,
                        "bridgeVersion": runtime.bridgeVersion ?? NSNull(),
                        "bridgeStatus": Self.jsonSafe(bridgeStatus),
                    ])
                    return
                }
                if self.isBridgeStatusError(bridgeStatus) {
                    self.writeWebFullBunSmokeProgress([
                        "ok": false,
                        "phase": "failed",
                        "nativePrewarm": true,
                        "error": "iOS full Bun backend failed to boot: \(bridgeStatus ?? NSNull())",
                        "finishedAt": self.isoTimestamp(),
                    ])
                    return
                }
                if elapsedMs >= 300_000 {
                    self.writeWebFullBunSmokeProgress([
                        "ok": false,
                        "phase": "failed",
                        "nativePrewarm": true,
                        "error": "iOS full Bun backend did not become ready within 60000ms; last status: \(bridgeStatus ?? NSNull())",
                        "finishedAt": self.isoTimestamp(),
                    ])
                    return
                }
                self.writeWebFullBunSmokeProgress([
                    "phase": "native-prewarm-waiting-backend",
                    "nativePrewarm": true,
                    "elapsedMs": elapsedMs,
                    "attempt": attempt,
                    "bridgeStatus": Self.jsonSafe(bridgeStatus),
                ])
                self.scheduleWebFullBunPrewarmReadyPoll(runtime: runtime, startedAt: startedAt, attempt: attempt + 1)
            }
        }
    }

    private func scheduleWebFullBunPrewarmReadyPoll(
        runtime: ElizaBunRuntime,
        startedAt: Date,
        attempt: Int
    ) {
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 2.0) { [weak self, weak runtime] in
            guard let self = self, let runtime = runtime else { return }
            self.pollWebFullBunPrewarmReady(runtime: runtime, startedAt: startedAt, attempt: attempt)
        }
    }

    private func runNativeFullBunSmokeAfterSuccessfulStartIfRequested(runtime: ElizaBunRuntime) {
        guard shouldRunNativeFullBunSmoke() else { return }
        nativeSmokeStarted = true
        writeFullBunSmokeProgress([
            "phase": "native-route-smoke-starting",
            "nativeOnly": true,
        ])
        runNativeFullBunRouteSmoke(runtime: runtime)
    }

    private func shouldRunNativeFullBunSmoke() -> Bool {
        guard !nativeSmokeStarted else { return false }
        if ProcessInfo.processInfo.environment[Self.fullBunSmokeEnvKey] == "1" {
            return true
        }
        return UserDefaults.standard.string(forKey: Self.fullBunSmokeRequestKey) == "1"
    }

    private func runNativeFullBunRouteSmoke(runtime: ElizaBunRuntime) {
        pollNativeFullBunBridgeReady(runtime: runtime, startedAt: Date(), attempt: 0)
    }

    private func pollNativeFullBunBridgeReady(
        runtime: ElizaBunRuntime,
        startedAt: Date,
        attempt: Int
    ) {
        dispatchSmokeCall(runtime: runtime, method: "status", args: ["timeoutMs": 5_000]) { [weak self, weak runtime] statusResult in
            guard let self = self, let runtime = runtime else { return }
            let elapsedMs = Int(Date().timeIntervalSince(startedAt) * 1000)
            switch statusResult {
            case .failure(let error):
                if elapsedMs >= 300_000 {
                    self.writeFullBunSmokeFailure(error)
                    return
                }
                self.writeFullBunSmokeProgress([
                    "phase": "native-waiting-backend",
                    "nativeOnly": true,
                    "elapsedMs": elapsedMs,
                    "attempt": attempt,
                    "lastStatusError": error.localizedDescription,
                ])
                self.scheduleNativeBridgeReadyPoll(runtime: runtime, startedAt: startedAt, attempt: attempt + 1)
            case .success(let bridgeStatus):
                if self.isBridgeStatusReady(bridgeStatus) {
                    self.runNativeFullBunHealthSmoke(runtime: runtime, bridgeStatus: bridgeStatus)
                    return
                }
                if self.isBridgeStatusError(bridgeStatus) {
                    self.writeFullBunSmokeFailure(
                        self.makeSmokeError("native full Bun backend failed to boot: \(bridgeStatus ?? NSNull())")
                    )
                    return
                }
                if elapsedMs >= 300_000 {
                    self.writeFullBunSmokeFailure(
                        self.makeSmokeError("native full Bun backend did not become ready within 60000ms; last status: \(bridgeStatus ?? NSNull())")
                    )
                    return
                }
                self.writeFullBunSmokeProgress([
                    "phase": "native-waiting-backend",
                    "nativeOnly": true,
                    "elapsedMs": elapsedMs,
                    "attempt": attempt,
                    "bridgeStatus": Self.jsonSafe(bridgeStatus),
                ])
                self.scheduleNativeBridgeReadyPoll(runtime: runtime, startedAt: startedAt, attempt: attempt + 1)
            }
        }
    }

    private func scheduleNativeBridgeReadyPoll(
        runtime: ElizaBunRuntime,
        startedAt: Date,
        attempt: Int
    ) {
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 2.0) { [weak self, weak runtime] in
            guard let self = self, let runtime = runtime else { return }
            self.pollNativeFullBunBridgeReady(runtime: runtime, startedAt: startedAt, attempt: attempt)
        }
    }

    private func runNativeFullBunHealthSmoke(runtime: ElizaBunRuntime, bridgeStatus: Any?) {
        let healthArgs: [String: Any] = [
            "method": "GET",
            "path": "/api/health",
            "headers": ["accept": "application/json"],
            "timeoutMs": 120_000,
        ]
        dispatchSmokeCall(runtime: runtime, method: "http_request", args: healthArgs) { [weak self, weak runtime] healthResult in
            guard let self = self, let runtime = runtime else { return }
            switch healthResult {
            case .failure(let error):
                self.writeFullBunSmokeFailure(error)
            case .success(let healthResponse):
                do {
                    let healthJson = try self.parseSmokeHttpJSON(
                        label: "native full Bun /api/health",
                        value: healthResponse
                    )
                    guard healthJson["ready"] as? Bool == true,
                          healthJson["runtime"] as? String == "ok" else {
                        throw self.makeSmokeError(
                            "native full Bun /api/health returned unexpected body: \(healthJson)"
                        )
                    }
                    self.createNativeSmokeConversation(
                        runtime: runtime,
                        bridgeStatus: bridgeStatus,
                        health: healthJson
                    )
                } catch {
                    self.writeFullBunSmokeFailure(error)
                }
            }
        }
    }

    private func isBridgeStatusReady(_ value: Any?) -> Bool {
        guard let dict = value as? [String: Any] else { return false }
        if let ready = dict["ready"] as? Bool { return ready }
        if let ready = dict["ready"] as? NSNumber { return ready.boolValue }
        return false
    }

    private func isBridgeStatusError(_ value: Any?) -> Bool {
        guard let dict = value as? [String: Any] else { return false }
        return dict["phase"] as? String == "error"
    }

    private func createNativeSmokeConversation(
        runtime: ElizaBunRuntime,
        bridgeStatus: Any?,
        health: [String: Any]
    ) {
        let createArgs: [String: Any] = [
            "method": "POST",
            "path": "/api/conversations",
            "headers": [
                "accept": "application/json",
                "content-type": "application/json",
            ],
            "body": "{\"title\":\"iOS Full Bun Native Smoke\"}",
            "timeoutMs": 120_000,
        ]
        dispatchSmokeCall(runtime: runtime, method: "http_request", args: createArgs) { [weak self, weak runtime] createResult in
            guard let self = self, let runtime = runtime else { return }
            switch createResult {
            case .failure(let error):
                self.writeFullBunSmokeFailure(error)
            case .success(let createResponse):
                do {
                    let createJson = try self.parseSmokeHttpJSON(
                        label: "native full Bun POST /api/conversations",
                        value: createResponse
                    )
                    guard let conversation = createJson["conversation"] as? [String: Any],
                          let conversationId = conversation["id"] as? String,
                          !conversationId.isEmpty else {
                        throw self.makeSmokeError("native full Bun conversation create did not return an id")
                    }
                    self.sendNativeSmokeMessage(
                        runtime: runtime,
                        bridgeStatus: bridgeStatus,
                        health: health,
                        conversationId: conversationId
                    )
                } catch {
                    self.writeFullBunSmokeFailure(error)
                }
            }
        }
    }

    private func sendNativeSmokeMessage(
        runtime: ElizaBunRuntime,
        bridgeStatus: Any?,
        health: [String: Any],
        conversationId: String
    ) {
        let messageArgs: [String: Any] = [
            "message": "iOS full Bun native smoke",
            "conversationId": conversationId,
            "metadata": ["smoke": "ios-full-bun-native"],
            "timeoutMs": 600_000,
        ]
        dispatchSmokeCall(runtime: runtime, method: "send_message", args: messageArgs) { [weak self] messageResult in
            guard let self = self else { return }
            switch messageResult {
            case .failure(let error):
                self.writeFullBunSmokeFailure(error)
            case .success(let sendMessage):
                self.writeFullBunSmokeProgress([
                    "ok": true,
                    "phase": "native-complete",
                    "nativeOnly": true,
                    "finishedAt": self.isoTimestamp(),
                    "engine": runtime.engineMode,
                    "bridgeVersion": runtime.bridgeVersion ?? NSNull(),
                    "bridgeStatus": Self.jsonSafe(bridgeStatus),
                    "health": Self.jsonSafe(health),
                    "conversationId": conversationId,
                    "sendMessage": Self.jsonSafe(sendMessage),
                ])
            }
        }
    }

    private func dispatchSmokeCall(
        runtime: ElizaBunRuntime,
        method: String,
        args: Any?,
        completion: @escaping (Result<Any?, Error>) -> Void
    ) {
        runtime.dispatchHandler(method: method, args: args) { result in
            completion(result)
        }
    }

    private func parseSmokeHttpJSON(label: String, value: Any?) throws -> [String: Any] {
        guard let response = value as? [String: Any] else {
            throw makeSmokeError("\(label) did not return an object")
        }
        let status = (response["status"] as? NSNumber)?.intValue ?? response["status"] as? Int
        guard let status = status, status >= 200, status < 300 else {
            throw makeSmokeError("\(label) returned HTTP \(String(describing: response["status"]))")
        }
        guard let body = response["body"] as? String,
              let data = body.data(using: .utf8),
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw makeSmokeError("\(label) returned invalid JSON body")
        }
        return json
    }

    private func writeFullBunSmokeFailure(_ error: Error) {
        writeFullBunSmokeResult([
            "ok": false,
            "phase": "failed",
            "nativeOnly": true,
            "error": error.localizedDescription,
            "finishedAt": isoTimestamp(),
        ])
        UserDefaults.standard.removeObject(forKey: Self.fullBunSmokeRequestKey)
        UserDefaults.standard.synchronize()
    }

    private func writeFullBunSmokeProgress(_ result: [String: Any]) {
        if let existing = UserDefaults.standard.string(forKey: Self.fullBunSmokeResultKey),
           let data = existing.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           json["ok"] as? Bool == true {
            return
        }
        writeFullBunSmokeResult(result)
        if result["ok"] as? Bool == true {
            UserDefaults.standard.removeObject(forKey: Self.fullBunSmokeRequestKey)
            UserDefaults.standard.synchronize()
        }
    }

    private func writeFullBunSmokeResult(_ result: [String: Any]) {
        var payload = result
        payload["updatedAt"] = isoTimestamp()
        let safePayload = Self.jsonSafe(payload)
        guard JSONSerialization.isValidJSONObject(safePayload),
              let data = try? JSONSerialization.data(withJSONObject: safePayload),
              let json = String(data: data, encoding: .utf8) else {
            return
        }
        UserDefaults.standard.set(json, forKey: Self.fullBunSmokeResultKey)
        UserDefaults.standard.synchronize()
    }

    private func writeWebFullBunSmokeProgress(_ result: [String: Any]) {
        var payload = result
        payload["updatedAt"] = isoTimestamp()
        let safePayload = Self.jsonSafe(payload)
        guard JSONSerialization.isValidJSONObject(safePayload),
              let data = try? JSONSerialization.data(withJSONObject: safePayload),
              let json = String(data: data, encoding: .utf8) else {
            return
        }
        UserDefaults.standard.set(json, forKey: Self.webFullBunPrewarmResultKey)
        UserDefaults.standard.synchronize()
    }

    private func makeSmokeError(_ message: String) -> NSError {
        NSError(
            domain: "ElizaBunRuntimeSmoke",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }

    private func isoTimestamp() -> String {
        ISO8601DateFormatter().string(from: Date())
    }

    /// Capacitor's bridge serializes a known set of Foundation types
    /// (`NSString`, `NSNumber`, `NSArray`, `NSDictionary`, `NSNull`). Other
    /// types get coerced to their string description so the React side
    /// always sees something.
    private static func jsonSafe(_ value: Any?) -> Any {
        guard let value = value else { return NSNull() }
        if value is NSNull { return NSNull() }
        if let s = value as? String { return s }
        if let n = value as? NSNumber { return n }
        if let arr = value as? [Any] { return arr.map { jsonSafe($0) } }
        if let dict = value as? [String: Any] {
            var out: [String: Any] = [:]
            for (k, v) in dict { out[k] = jsonSafe(v) }
            return out
        }
        return String(describing: value)
    }
}

// Compatibility helper for `call.getArray<T>` typed access on older Capacitor
// builds that don't expose the generic form.
extension CAPPluginCall {
    func getArray<T>(_ key: String, _: T.Type) -> [T]? {
        guard let raw = self.getArray(key) else { return nil }
        return raw.compactMap { $0 as? T }
    }
}
