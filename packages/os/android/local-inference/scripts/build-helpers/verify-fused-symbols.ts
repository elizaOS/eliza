/**
 * Gate for the cross-built Android libelizainference.so: its exported ABI
 * symbols, the ABI version and voice probes read from its machine code, and
 * 16 KiB LOAD alignment.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";

function dumpSymbols({ tool, file }) {
  const result = spawnSync(tool.cmd, [...tool.args, file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(
      `[omnivoice-verify] symbol-verify: ${tool.cmd} failed to run on ${file}: ${result.error.message}`,
    );
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(
      `[omnivoice-verify] symbol-verify: ${tool.cmd} ${tool.args.join(" ")} ${file} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout || "";
}

/** Every eliza_inference_* export the Android JNI host may bind. */
export const REQUIRED_ELIZA_INFERENCE_SYMBOLS = Object.freeze([
  "eliza_inference_abi_version",
  "eliza_inference_create",
  "eliza_inference_destroy",
  "eliza_inference_mmap_acquire",
  "eliza_inference_mmap_evict",
  "eliza_inference_tts_synthesize",
  "eliza_inference_asr_transcribe",
  // ABI v2 — streaming ASR session API.
  "eliza_inference_asr_stream_supported",
  "eliza_inference_asr_stream_open",
  "eliza_inference_asr_stream_feed",
  "eliza_inference_asr_stream_partial",
  "eliza_inference_asr_stream_finish",
  "eliza_inference_asr_stream_close",
  // ABI v2 — streaming TTS + native MTP verifier callback.
  "eliza_inference_tts_stream_supported",
  "eliza_inference_tts_synthesize_stream",
  "eliza_inference_cancel_tts",
  "eliza_inference_set_verifier_callback",
  // NOTE: the ABI v4 reference-voice profile encoding symbols
  // (`eliza_inference_encode_reference`, `eliza_inference_free_tokens`) were
  // required here, but the pinned omnivoice.cpp does not export them and the
  // shipped, working arm64 libelizainference.so does NOT carry them either
  // (verified: arm64 and a fresh x86_64 build export an IDENTICAL 24-symbol
  // eliza_inference_* set, neither including these two). They back
  // reference-voice cloning, which the on-device STT→agent→TTS path never
  // exercises. Requiring them failed every fresh fused build for symbols that
  // are not part of the live ABI, so they are dropped from the required set.
  // ABI v3 — native Silero VAD backend.
  "eliza_inference_vad_supported",
  "eliza_inference_vad_open",
  "eliza_inference_vad_process",
  "eliza_inference_vad_reset",
  "eliza_inference_vad_close",
  "eliza_inference_free_string",
  // ABI v8/v9 — in-process streaming LLM, MTP, KV-cache quant, embeddings,
  // tokenizer, and mmproj vision. The fused libelizainference is now the SOLE
  // on-device inference library (the standalone libllama.so +
  // libeliza-llama-shim.so "MTP set" is retired), so a fused lib missing any of
  // these is NOT a tolerable half-build that falls back to libllama — it is a
  // hard build error. Names are the exact exports declared in the engine's
  // tools/omnivoice/include/eliza-inference-ffi.h.
  "eliza_inference_llm_stream_supported",
  "eliza_inference_llm_stream_open",
  "eliza_inference_llm_stream_next",
  "eliza_inference_llm_mtp_supported",
  "eliza_inference_llm_kv_quant_supported",
  "eliza_inference_embed",
  "eliza_inference_tokenize",
  "eliza_inference_vision_supported",
  "eliza_inference_describe_image",
  // ABI v10 — Kokoro-82M TTS folded in-process. The static-fuse recipe sets
  // LLAMA_BUILD_KOKORO=ON so kokoro_lib (its own GGUF reader + iSTFT decoder)
  // links into libelizainference under the ELIZA_ENABLE_KOKORO define. These
  // exports prove the fold took effect — a fused lib that built omnivoice but
  // dropped kokoro (e.g. a target-ordering miss where kokoro_lib was not a
  // defined target when elizainference's `if(TARGET kokoro_lib)` evaluated) is
  // a half-fused artifact, not a tolerable fallback. Device-proven on a real
  // Pixel: kokoro_supported()==1 + 2.36s of synthesized PCM. The `*_supported`
  // entry is always exported (returns 0 when the build lacked kokoro_lib); the
  // `_load`/`_synthesize`/`_sample_rate` entries are exported by the v10 FFI
  // surface regardless, so requiring all four asserts the v10 ABI is present.
  "eliza_inference_kokoro_supported",
  "eliza_inference_kokoro_load",
  "eliza_inference_kokoro_synthesize",
  "eliza_inference_kokoro_sample_rate",
  // ABI v14 — Kokoro IPA input + G2P-kind query (#11776) intentionally remains
  // optional until the pinned llama.cpp submodule declares and exports it. The
  // current develop gitlink is ABI v12: runtime bindings probe these symbols and
  // fall back to `"unknown"` G2P when absent. Requiring the future v14 exports
  // here made every Android fused build fail after producing a valid v12
  // libelizainference.so, leaving mobile builds with stale prebuilt artifacts.
  // ABI v11 — end-of-turn scoring folded in-process. A single causal forward
  // pass over the tokenized partial transcript reads P(end-of-turn token),
  // replacing the retired node-llama-cpp controlledEvaluate() the EOT
  // classifiers needed. The model-based turn detector now runs through the
  // fused lib instead of a JS-only heuristic, so a fused build missing these is
  // a hard error (the heuristic is a degraded last resort, not a parallel
  // runtime). `_supported` always returns 1 for a v11 build.
  "eliza_inference_llm_eot_supported",
  "eliza_inference_llm_eot_score",
  // ABI v17 — Paradee-8M TTS with native misaki G2P, the batch ASR probe and
  // ASR cancel. Every v17 build exports these; `paradee_supported()` returns 0
  // in a build without ELIZA_ENABLE_PARADEE, so presence proves the ABI, not
  // the capability. Android staging reads what the probes return with
  // `assertAndroidVoiceLibrary`.
  "eliza_inference_paradee_supported",
  "eliza_inference_paradee_load",
  "eliza_inference_paradee_sample_rate",
  "eliza_inference_paradee_g2p_kind",
  "eliza_inference_paradee_phonemize",
  "eliza_inference_paradee_synthesize_alloc",
  "eliza_inference_paradee_synthesize_phonemes_alloc",
  "eliza_inference_paradee_stream_supported",
  "eliza_inference_paradee_synthesize_stream",
  "eliza_inference_asr_supported",
  "eliza_inference_asr_cancel",
  "eliza_inference_free_pcm",
  // Streaming ASR (ABI v2 symbols; served by the Parakeet-TDT backend since
  // the v18 fork). The Android JNI binds all six with RegisterNatives, so a
  // library without them would fail the bridge load.
  "eliza_inference_asr_stream_supported",
  "eliza_inference_asr_stream_open",
  "eliza_inference_asr_stream_feed",
  "eliza_inference_asr_stream_partial",
  "eliza_inference_asr_stream_finish",
  "eliza_inference_asr_stream_close",
]);

/** Oldest ABI bound by the Android bridge, including Paradee streaming. */
export const MIN_ANDROID_VOICE_ABI = 19;

/** Probes that must return 1 in a library staged for Android voice. */
export const ANDROID_VOICE_PROBES = Object.freeze([
  "eliza_inference_paradee_supported",
  "eliza_inference_paradee_stream_supported",
  "eliza_inference_asr_supported",
]);

// Instructions that only set up or tear down a frame, or mark a branch target.
const PROLOGUE_EPILOGUE =
  /^(bti\b|endbr64\b|nop\b|hint\b|paciasp\b|autiasp\b|pacibsp\b|autibsp\b|stp\s+x29, x30|ldp\s+x29, x30|mov\s+x29, sp|pushq?\s+%rbp|popq?\s+%rbp|movq?\s+%rsp, %rbp)/;

/** Split `llvm-objdump -d` output into {symbol: [instruction text]}. */
export function splitDisassembly(text) {
  const out = {};
  let current = null;
  for (const line of text.split("\n")) {
    const header = line.match(/^[0-9a-f]+ <([^>]+)>:$/);
    if (header) {
      current = header[1];
      out[current] = [];
      continue;
    }
    const insn = line.match(/^\s*[0-9a-f]+:\s+(.*)$/);
    if (current && insn) {
      out[current].push(
        insn[1]
          .replace(/\s*\/\/.*$/, "")
          .replace(/\s+/g, " ")
          .trim(),
      );
    }
  }
  return out;
}

// The function body up to and including its first return, without frame
// setup and without the alignment padding the linker puts after it.
function bodyUntilReturn(instructions) {
  const body = [];
  for (const insn of instructions) {
    if (!insn || PROLOGUE_EPILOGUE.test(insn)) continue;
    body.push(insn);
    if (/^retq?$/.test(insn)) break;
  }
  return body;
}

/**
 * The value a trivial `int f(void)` returns (`mov w0, #1; ret` on arm64,
 * `movl $1, %eax; retq` on x86_64), or null when the body is anything else.
 * This reads what a `*_supported()` probe answers in a cross-built library
 * that cannot run on the build host.
 */
export function constantReturnValue(instructions) {
  const body = bodyUntilReturn(instructions);
  if (body.length !== 2 || !/^retq?$/.test(body[1])) return null;
  const insn = body[0];
  if (/^mov w0, wzr$/.test(insn) || /^xorl %eax, %eax$/.test(insn)) return 0;
  const arm = insn.match(/^(?:mov|orr) w0, (?:wzr, )?#(0x[0-9a-f]+|\d+)$/);
  if (arm) return Number(arm[1]);
  const x86 = insn.match(/^movl \$(0x[0-9a-f]+|\d+), %eax$/);
  if (x86) return Number(x86[1]);
  return null;
}

/**
 * The address a `const char *f(void)` returns when its body loads one
 * PC-relative constant: `adrp x0, PAGE; add x0, x0, #OFF; ret` on arm64 or
 * `leaq OFF(%rip), %rax # ADDR; retq` on x86_64. Null otherwise.
 * `instructions` must come from `--no-show-raw-insn` output (llvm-objdump
 * prints the resolved target address of PC-relative operands).
 */
export function constantPointerReturn(instructions) {
  const body = bodyUntilReturn(instructions);
  if (body.length === 3 && /^retq?$/.test(body[2])) {
    const page = body[0].match(/^adrp x0, (0x[0-9a-f]+)/);
    const add = body[1].match(/^add x0, x0, #(0x[0-9a-f]+|\d+)$/);
    if (page && add) return Number(page[1]) + Number(add[1]);
  }
  if (body.length === 2 && /^retq?$/.test(body[1])) {
    // The linker relaxes a near adrp+add into `nop; adr` (the nop is skipped).
    const adr = body[0].match(/^adr x0, (0x[0-9a-f]+)/);
    if (adr) return Number(adr[1]);
    const lea = body[0].match(
      /^leaq -?0x[0-9a-f]+\(%rip\), %rax # (0x[0-9a-f]+)/,
    );
    if (lea) return Number(lea[1]);
  }
  return null;
}

/** NUL-terminated string at virtual address `address` of a 64-bit little-endian ELF. */
export function readElfCString(bytes, address) {
  if (
    bytes.readUInt32BE(0) !== 0x7f454c46 ||
    bytes[4] !== 2 ||
    bytes[5] !== 1
  ) {
    throw new Error("not a 64-bit little-endian ELF file");
  }
  const phoff = Number(bytes.readBigUInt64LE(0x20));
  const phentsize = bytes.readUInt16LE(0x36);
  const phnum = bytes.readUInt16LE(0x38);
  for (let i = 0; i < phnum; i++) {
    const ph = phoff + i * phentsize;
    if (bytes.readUInt32LE(ph) !== 1) continue; // PT_LOAD
    const offset = Number(bytes.readBigUInt64LE(ph + 8));
    const vaddr = Number(bytes.readBigUInt64LE(ph + 16));
    const filesz = Number(bytes.readBigUInt64LE(ph + 32));
    if (address >= vaddr && address < vaddr + filesz) {
      const start = offset + (address - vaddr);
      const end = bytes.indexOf(0, start);
      if (end < 0 || end > offset + filesz) return null;
      return bytes.subarray(start, end).toString("utf8");
    }
  }
  return null;
}

/** Smallest PT_LOAD alignment of a 64-bit little-endian ELF (16 KiB pages need >= 0x4000). */
export function minElfLoadAlignment(bytes) {
  const phoff = Number(bytes.readBigUInt64LE(0x20));
  const phentsize = bytes.readUInt16LE(0x36);
  const phnum = bytes.readUInt16LE(0x38);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < phnum; i++) {
    const ph = phoff + i * phentsize;
    if (bytes.readUInt32LE(ph) !== 1) continue;
    min = Math.min(min, Number(bytes.readBigUInt64LE(ph + 48)));
  }
  return min;
}

/**
 * Gate for a cross-built Android libelizainference.so (it cannot run on the
 * build host). Requires the full ABI symbol set, reads the ABI version string
 * and the value each voice probe returns from the machine code, and requires
 * ABI >= 17, every ANDROID_VOICE_PROBES entry == 1, and 16 KiB LOAD alignment.
 * Pass the unstripped library or a stripped one with .dynsym; `objdump` and
 * `nm` are the NDK llvm tools.
 */
export function assertAndroidVoiceLibrary({ lib, objdump, nm }) {
  const symbols = dumpSymbols({
    tool: { cmd: nm, args: ["-D", "--defined-only"] },
    file: lib,
  });
  const missing = REQUIRED_ELIZA_INFERENCE_SYMBOLS.filter(
    (name) => !hasExportedSymbol(symbols, name),
  );
  if (missing.length > 0) {
    throw new Error(
      `[omnivoice-verify] android-voice: ${lib} is missing ABI symbol(s): ${missing.join(", ")}`,
    );
  }
  const probed = ["eliza_inference_abi_version", ...ANDROID_VOICE_PROBES];
  const disassembly = splitDisassembly(
    dumpSymbols({
      tool: {
        cmd: objdump,
        args: [
          "-d",
          "--no-show-raw-insn",
          `--disassemble-symbols=${probed.join(",")}`,
        ],
      },
      file: lib,
    }),
  );
  const bytes = fs.readFileSync(lib);
  const abiAddress = constantPointerReturn(
    disassembly.eliza_inference_abi_version ?? [],
  );
  const abiText =
    abiAddress === null ? null : readElfCString(bytes, abiAddress);
  const abiVersion =
    abiText !== null && /^\d+$/.test(abiText) ? Number(abiText) : null;
  if (abiVersion === null) {
    throw new Error(
      `[omnivoice-verify] android-voice: cannot read eliza_inference_abi_version() from ${lib}; it no longer returns one string constant`,
    );
  }
  if (abiVersion < MIN_ANDROID_VOICE_ABI) {
    throw new Error(
      `[omnivoice-verify] android-voice: ${lib} is ABI ${abiVersion}; the Android voice bridge needs ABI ${MIN_ANDROID_VOICE_ABI} or newer`,
    );
  }
  const probes = {};
  for (const probe of ANDROID_VOICE_PROBES) {
    const value = constantReturnValue(disassembly[probe] ?? []);
    probes[probe] = value;
    if (value !== 1) {
      throw new Error(
        `[omnivoice-verify] android-voice: ${probe}() in ${lib} returns ${value === null ? "a non-constant value" : value}, not 1. Build with -DLLAMA_BUILD_PARADEE=ON -DLLAMA_BUILD_MISAKI_G2P=ON.`,
      );
    }
  }
  const alignment = minElfLoadAlignment(bytes);
  if (alignment < 0x4000) {
    throw new Error(
      `[omnivoice-verify] android-voice: ${lib} has a LOAD segment aligned to ${alignment} bytes; Android 15+ 16 KiB pages need 16384`,
    );
  }
  return { abiVersion, probes, loadAlignment: alignment };
}

function hasExportedSymbol(symbols, name) {
  return new RegExp(`\\b_?${name}\\b`).test(symbols);
}
