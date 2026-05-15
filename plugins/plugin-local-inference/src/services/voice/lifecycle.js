/**
 * Voice on/off state machine.
 *
 * Per `packages/inference/AGENTS.md` §4 + this scope's design goals,
 * voice is OFF by default. Text + drafter are hot; TTS, ASR, the
 * speaker preset cache and phrase cache, the chunker, the rollback
 * queue, the barge-in controller, and the ring buffer are NOT in RAM.
 *
 * Transitions are explicit. Illegal transitions throw — no
 * "log-and-continue" (AGENTS.md §9). The transition to `voice-off`
 * MUST issue a real page-eviction call on the TTS/ASR mmap regions
 * (see `MmapRegionHandle.evictPages()` in `shared-resources.ts`) so
 * the OS can reclaim those pages.
 *
 *   ┌──────────┐ start()  ┌──────────────┐ armed   ┌──────────┐
 *   │ voice-off│─────────▶│ voice-arming │────────▶│ voice-on │
 *   └──────────┘          └──────────────┘         └──────────┘
 *        ▲                       │ start fails           │ stop()
 *        │ disarmed              ▼                       ▼
 *  ┌──────────────────┐    ┌──────────────┐  ┌────────────────────┐
 *  │ voice-disarming  │◀───│ voice-error  │  │  voice-disarming   │
 *  └──────────────────┘    └──────────────┘  └────────────────────┘
 *        │                                            │
 *        └────────────────── disarmed ◀───────────────┘
 *
 * `voice-error` is terminal until `reset()` is called. There is no
 * automatic retry: a missing kernel, mmap fail, or RAM-pressure
 * refusal MUST surface to the caller.
 */
/**
 * Structured failure surfaced to the caller. Never a generic `Error` —
 * the caller (engine + UI) needs to distinguish RAM pressure from a
 * missing kernel from a manifest mismatch (AGENTS.md §3).
 */
export class VoiceLifecycleError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "VoiceLifecycleError";
        this.code = code;
    }
}
export class VoiceLifecycle {
    state = { kind: "voice-off" };
    registry;
    loaders;
    events;
    constructor(args) {
        this.registry = args.registry;
        this.loaders = args.loaders;
        this.events = args.events ?? {};
    }
    current() {
        return this.state;
    }
    /**
     * Transition `voice-off → voice-arming → voice-on`. Loads TTS + ASR
     * mmap regions, voice caches, voice scheduler nodes. Each load throws
     * on failure; a thrown loader transitions the state to `voice-error`
     * and re-throws so the caller sees the structured cause. No partial
     * arm: either all four resources are held or none are.
     */
    async arm() {
        if (this.state.kind !== "voice-off") {
            throw new VoiceLifecycleError("illegal-transition", `[voice-lifecycle] arm() called in state ${this.state.kind} — must be voice-off`);
        }
        this.transition({ kind: "voice-arming" });
        let tts = null;
        let asr = null;
        let voiceCaches = null;
        let voiceSchedulerNodes = null;
        try {
            tts = this.registry.acquire(await this.loaders.loadTtsRegion());
            asr = this.registry.acquire(await this.loaders.loadAsrRegion());
            voiceCaches = this.registry.acquire(await this.loaders.loadVoiceCaches());
            voiceSchedulerNodes = this.registry.acquire(await this.loaders.loadVoiceSchedulerNodes());
        }
        catch (err) {
            // Roll back partial acquisitions before surfacing the error so the
            // registry doesn't leak refs on a failed arm. Evict heavy mmap
            // regions before release; release() only drops the refcount and may
            // intentionally keep file descriptors alive for future re-page.
            await Promise.allSettled([
                tts?.evictPages() ?? Promise.resolve(),
                asr?.evictPages() ?? Promise.resolve(),
            ]);
            const rollback = [
                voiceSchedulerNodes,
                voiceCaches,
                asr,
                tts,
            ];
            for (const res of rollback) {
                if (res)
                    await this.registry.release(res.id);
            }
            const lifecycleErr = toLifecycleError("arm-failed", err);
            this.transition({ kind: "voice-error", error: lifecycleErr });
            throw lifecycleErr;
        }
        const resources = {
            tts,
            asr,
            voiceCaches,
            voiceSchedulerNodes,
        };
        this.transition({ kind: "voice-on", resources });
        return resources;
    }
    /**
     * Transition `voice-on → voice-disarming → voice-off`. Calls
     * `evictPages()` on the TTS + ASR mmap regions before releasing them
     * so the OS reclaims the pages even if another consumer keeps the
     * file descriptor open. The voice caches stay in the registry as
     * tiny (KB-scale) entries — only the heavy mmap regions get evicted.
     */
    async disarm() {
        if (this.state.kind !== "voice-on") {
            throw new VoiceLifecycleError("illegal-transition", `[voice-lifecycle] disarm() called in state ${this.state.kind} — must be voice-on`);
        }
        const resources = this.state.resources;
        this.transition({ kind: "voice-disarming", resources });
        let evictionFailure = null;
        // Eviction first — the mmap region is still mapped, the kernel can
        // still drop the pages. If eviction fails we still proceed to
        // release; the failure is captured and re-thrown after release so
        // the registry stays consistent.
        //
        // `evictPages()` on production handles wires through to the
        // `libelizainference` FFI (`ffi.mmapEvict(ctx, "tts" | "asr")`,
        // declared in `scripts/omnivoice-fuse/ffi.h`). The fused build
        // implements that as `madvise(MADV_DONTNEED)` on POSIX or
        // `VirtualUnlock + OfferVirtualMemory` on Windows. The stub
        // library returns ELIZA_ERR_NOT_IMPLEMENTED, which the binding
        // raises as `VoiceLifecycleError({code:"kernel-missing"})` — this
        // method captures it and re-classifies as `disarm-failed` after
        // release runs (so registry refs don't leak on a bad eviction).
        const evictResults = await Promise.allSettled([
            resources.tts.evictPages(),
            resources.asr.evictPages(),
        ]);
        for (const r of evictResults) {
            if (r.status === "rejected" && evictionFailure === null) {
                evictionFailure = r.reason;
            }
        }
        // Release in reverse acquisition order.
        await this.registry.release(resources.voiceSchedulerNodes.id);
        await this.registry.release(resources.voiceCaches.id);
        await this.registry.release(resources.asr.id);
        await this.registry.release(resources.tts.id);
        if (evictionFailure !== null) {
            const err = toLifecycleError("disarm-failed", evictionFailure);
            this.transition({ kind: "voice-error", error: err });
            throw err;
        }
        this.transition({ kind: "voice-off" });
    }
    /**
     * Reset from `voice-error` back to `voice-off`. Required because
     * `voice-error` is terminal — the engine must explicitly acknowledge
     * the failure before the user can re-attempt voice. There is no
     * automatic retry path.
     */
    reset() {
        if (this.state.kind !== "voice-error") {
            throw new VoiceLifecycleError("illegal-transition", `[voice-lifecycle] reset() called in state ${this.state.kind} — must be voice-error`);
        }
        this.transition({ kind: "voice-off" });
    }
    transition(next) {
        const prev = this.state;
        this.state = next;
        this.events.onTransition?.(prev, next);
    }
}
function toLifecycleError(fallbackCode, err) {
    if (err instanceof VoiceLifecycleError)
        return err;
    const message = err instanceof Error ? err.message : String(err);
    // Heuristic mapping of common platform-level signals into the
    // structured codes documented above. The lifecycle never fabricates
    // a code it didn't receive evidence for — anything that doesn't match
    // one of these falls back to the caller-provided code.
    if (/ENOMEM|out of memory|RAM/i.test(message)) {
        return new VoiceLifecycleError("ram-pressure", message);
    }
    if (/mmap|MAP_FAILED/i.test(message)) {
        return new VoiceLifecycleError("mmap-fail", message);
    }
    if (/kernel|missing kernel/i.test(message)) {
        return new VoiceLifecycleError("kernel-missing", message);
    }
    return new VoiceLifecycleError(fallbackCode, message);
}
//# sourceMappingURL=lifecycle.js.map