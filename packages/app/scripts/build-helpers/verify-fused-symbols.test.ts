import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANDROID_VOICE_PROBES,
  assertVulkanMaliMitigation,
  constantPointerReturn,
  constantReturnValue,
  minElfLoadAlignment,
  REQUIRED_ELIZA_INFERENCE_SYMBOLS,
  readElfCString,
  splitDisassembly,
} from "./verify-fused-symbols.ts";

const MARKER = "GGML_VK_FA_ALLOW_SUBGROUPS";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const fusedFfiHeader = path.join(
  repoRoot,
  "plugins/plugin-local-inference/native/llama.cpp/tools/omnivoice/include/eliza-inference-ffi.h",
);

// The Mali gate only scans fixture bytes for a marker, so no native build is
// needed to exercise the release-blocking decision tree.
function fixtureLib({
  backendBytes = null,
  fusedBytes = "not a real fused lib",
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fused-verify-"));
  const lib = path.join(dir, "libelizainference.so");
  fs.writeFileSync(lib, Buffer.from(fusedBytes));
  if (backendBytes !== null) {
    fs.writeFileSync(
      path.join(dir, "libggml-vulkan.so"),
      Buffer.from(backendBytes),
    );
  }
  return lib;
}

describe("assertVulkanMaliMitigation — #9508 fail-closed Mali flash-attn gate", () => {
  it("is a no-op for non-vulkan targets", () => {
    const lib = fixtureLib({});
    expect(() =>
      assertVulkanMaliMitigation({ lib, target: "linux-x64-cpu-fused" }),
    ).not.toThrow();
  });

  it("passes when libggml-vulkan.so carries the Mali mitigation marker", () => {
    const lib = fixtureLib({ backendBytes: `prefix-${MARKER}-suffix` });
    expect(() =>
      assertVulkanMaliMitigation({ lib, target: "linux-x64-vulkan-fused" }),
    ).not.toThrow();
  });

  it("passes when statically fused Vulkan carries the mitigation marker in libelizainference", () => {
    const lib = fixtureLib({ fusedBytes: `prefix-${MARKER}-suffix` });
    expect(() =>
      assertVulkanMaliMitigation({ lib, target: "android-arm64-vulkan-fused" }),
    ).not.toThrow();
  });

  it("throws fail-closed on a stale pre-#9508 backend missing the marker", () => {
    const lib = fixtureLib({
      backendBytes: "a vulkan backend without the mitigation marker",
    });
    expect(() =>
      assertVulkanMaliMitigation({ lib, target: "android-arm64-vulkan-fused" }),
    ).toThrow(/Mali flash-attn mitigation marker/);
  });

  it("throws fail-closed when no Vulkan output carries the mitigation marker", () => {
    const lib = fixtureLib({});
    expect(() =>
      assertVulkanMaliMitigation({ lib, target: "android-arm64-vulkan-fused" }),
    ).toThrow(/neither libggml-vulkan\.so.*GGML_VK_FA_ALLOW_SUBGROUPS/);
  });
});

const headerDescribe = fs.existsSync(fusedFfiHeader) ? describe : describe.skip;

headerDescribe("REQUIRED_ELIZA_INFERENCE_SYMBOLS", () => {
  it("does not require symbols ahead of the pinned fused FFI header", () => {
    const header = fs.readFileSync(fusedFfiHeader, "utf8");
    const missingFromHeader = REQUIRED_ELIZA_INFERENCE_SYMBOLS.filter(
      (symbol) => !new RegExp(`\\b${symbol}\\s*\\(`).test(header),
    );
    expect(missingFromHeader).toEqual([]);
  });
});

// `llvm-objdump -d --no-show-raw-insn` output of NDK 28.2 -O2 builds of
// `const char *abi(void) { return "17"; }` and `int probe(void) { return N; }`.
const ARM64_DISASSEMBLY = `
00000000000046e8 <eliza_inference_abi_version>:
    46e8:      \tnop
    46ec:      \tadr\tx0, 0x540 <__register_atfork+0x540>
    46f0:      \tret

00000000000046f4 <eliza_inference_paradee_supported>:
    46f4:      \tmov\tw0, #0x1                // =1
    46f8:      \tret

0000000000004704 <eliza_inference_asr_supported>:
    4704:      \tmov\tw0, wzr
    4708:      \tret
`;
const X86_64_DISASSEMBLY = `
0000000000004700 <eliza_inference_abi_version>:
    4700:      \tleaq\t-0x41c7(%rip), %rax     # 0x540 <__register_atfork+0x540>
    4707:      \tretq
    4708:      \tnopl\t(%rax,%rax)

0000000000004710 <eliza_inference_paradee_supported>:
    4710:      \tpushq\t%rbp
    4711:      \tmovq\t%rsp, %rbp
    4714:      \tmovl\t$0x1, %eax
    4719:      \tpopq\t%rbp
    471a:      \tretq
    471b:      \tnopw\t%cs:(%rax,%rax)

0000000000004730 <eliza_inference_asr_supported>:
    4730:      \tjmp\t0x9000 <probe_at_runtime>
`;

// A minimal 64-bit little-endian ELF: one PT_LOAD mapping file offset 0x100
// to virtual address 0x10100 with the given alignment, holding `text`.
function elfWithString(text, align = 0x4000) {
  const bytes = Buffer.alloc(0x200);
  bytes.writeUInt32BE(0x7f454c46, 0);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeBigUInt64LE(0x40n, 0x20); // e_phoff
  bytes.writeUInt16LE(56, 0x36); // e_phentsize
  bytes.writeUInt16LE(1, 0x38); // e_phnum
  bytes.writeUInt32LE(1, 0x40); // PT_LOAD
  bytes.writeBigUInt64LE(0x100n, 0x48); // p_offset
  bytes.writeBigUInt64LE(0x10100n, 0x50); // p_vaddr
  bytes.writeBigUInt64LE(0x100n, 0x60); // p_filesz
  bytes.writeBigUInt64LE(BigInt(align), 0x70); // p_align
  bytes.write(`${text}\0`, 0x100, "utf8");
  return bytes;
}

describe("Android voice probes read cross-built machine code", () => {
  it("reads constant probe returns on arm64 and x86_64", () => {
    const arm = splitDisassembly(ARM64_DISASSEMBLY);
    expect(constantReturnValue(arm.eliza_inference_paradee_supported)).toBe(1);
    expect(constantReturnValue(arm.eliza_inference_asr_supported)).toBe(0);
    const x86 = splitDisassembly(X86_64_DISASSEMBLY);
    expect(constantReturnValue(x86.eliza_inference_paradee_supported)).toBe(1);
    // A probe that is not one constant return is not trusted as supported.
    expect(constantReturnValue(x86.eliza_inference_asr_supported)).toBeNull();
  });

  it("resolves the ABI string address after linker relaxation", () => {
    expect(
      constantPointerReturn(
        splitDisassembly(ARM64_DISASSEMBLY).eliza_inference_abi_version,
      ),
    ).toBe(0x540);
    expect(
      constantPointerReturn(
        splitDisassembly(X86_64_DISASSEMBLY).eliza_inference_abi_version,
      ),
    ).toBe(0x540);
    expect(
      constantPointerReturn([
        "adrp x0, 0x12000 <foo>",
        "add x0, x0, #0x34",
        "ret",
      ]),
    ).toBe(0x12034);
  });

  it("reads the string at a virtual address and the LOAD alignment", () => {
    const elf = elfWithString("17");
    expect(readElfCString(elf, 0x10100)).toBe("17");
    expect(readElfCString(elf, 0x20000)).toBeNull();
    expect(minElfLoadAlignment(elf)).toBe(0x4000);
    expect(minElfLoadAlignment(elfWithString("17", 0x1000))).toBe(0x1000);
  });

  it("requires every probe it gates to be part of the exported ABI", () => {
    for (const probe of ANDROID_VOICE_PROBES) {
      expect(REQUIRED_ELIZA_INFERENCE_SYMBOLS).toContain(probe);
    }
  });
});
