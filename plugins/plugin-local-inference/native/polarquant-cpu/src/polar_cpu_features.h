/*
 * Runtime CPU feature detection for the PolarQuant CPU dispatch table.
 *
 * The build still compiles each SIMD TU only for arches where its
 * intrinsics exist (AVX2/AVX-VNNI on x86_64, NEON / dot-product on
 * AArch64), but the dispatcher picks the best *available* path at
 * runtime via cpuid / hwcap so a binary built with AVX-VNNI support
 * still runs on an AVX2-only host (and a NEON-only host doesn't trap
 * on a `vdotq_s32`).
 */
#ifndef POLAR_CPU_FEATURES_H
#define POLAR_CPU_FEATURES_H

#include <stdint.h>

#if defined(__x86_64__) || defined(__i386__) || defined(_M_X64) || defined(_M_IX86)
#  define POLAR_ARCH_X86 1
#  if defined(_MSC_VER)
#    include <intrin.h>
#  else
#    include <cpuid.h>
#  endif
#endif

#if defined(__aarch64__) || defined(__arm64__)
#  define POLAR_ARCH_ARM64 1
#  if defined(__linux__)
#    include <sys/auxv.h>
#    include <asm/hwcap.h>
#  endif
#endif

#if defined(__riscv) && (__riscv_xlen == 64)
#  ifndef POLAR_ARCH_RISCV
#    define POLAR_ARCH_RISCV 1
#  endif
#  if defined(__has_include)
#    if __has_include(<sys/hwprobe.h>)
#      include <sys/hwprobe.h>
#      define POLAR_HAS_HWPROBE 1
#    endif
#    if __has_include(<sys/auxv.h>)
#      include <sys/auxv.h>
#      define POLAR_HAS_AUXV 1
#    endif
#    if __has_include(<asm/hwcap.h>)
#      include <asm/hwcap.h>
#    endif
#  endif
#endif

typedef struct {
    int has_avx2;
    int has_fma;
    int has_avx_vnni;   /* 256-bit VPDPBUSD via AVX-VNNI (Alder Lake+) */
    int has_neon;       /* always 1 on AArch64 */
    int has_dotprod;    /* ARMv8.4 SDOT/UDOT */
    int has_i8mm;       /* ARMv8.6 int8 matrix multiply */
    /* RISC-V V extension probes. Detection plumbing only for Wave 1;
     * Wave 3 wires the RVV kernels and the dispatcher branches. */
    unsigned int has_rvv : 1;
    unsigned int has_rvv_zvfh : 1;
} polar_cpu_features_t;

static inline void polar_detect_cpu(polar_cpu_features_t *f) {
    f->has_avx2 = f->has_fma = f->has_avx_vnni = 0;
    f->has_neon = f->has_dotprod = f->has_i8mm = 0;
    f->has_rvv = 0;
    f->has_rvv_zvfh = 0;

#if defined(POLAR_ARCH_X86)
    {
        unsigned int eax, ebx, ecx, edx;
#  if defined(_MSC_VER)
        int regs[4];
        __cpuidex(regs, 1, 0);
        ecx = (unsigned)regs[2]; edx = (unsigned)regs[3]; (void)edx;
        f->has_fma = (ecx >> 12) & 1;
        __cpuidex(regs, 7, 0);
        ebx = (unsigned)regs[1]; (void)ebx;
        f->has_avx2 = (ebx >> 5) & 1;
        __cpuidex(regs, 7, 1);
        eax = (unsigned)regs[0];
        f->has_avx_vnni = (eax >> 4) & 1;   /* CPUID.(EAX=7,ECX=1):EAX[4] */
#  else
        if (__get_cpuid_count(1, 0, &eax, &ebx, &ecx, &edx)) {
            f->has_fma = (ecx >> 12) & 1;
        }
        if (__get_cpuid_count(7, 0, &eax, &ebx, &ecx, &edx)) {
            f->has_avx2 = (ebx >> 5) & 1;
        }
        if (__get_cpuid_count(7, 1, &eax, &ebx, &ecx, &edx)) {
            f->has_avx_vnni = (eax >> 4) & 1;
        }
#  endif
    }
#endif

#if defined(POLAR_ARCH_ARM64)
    f->has_neon = 1;
#  if defined(__linux__)
    {
        unsigned long hw = getauxval(AT_HWCAP);
#    ifdef HWCAP_ASIMDDP
        f->has_dotprod = (hw & HWCAP_ASIMDDP) ? 1 : 0;
#    endif
#    ifdef HWCAP2_I8MM
        {
            unsigned long hw2 = getauxval(AT_HWCAP2);
            f->has_i8mm = (hw2 & HWCAP2_I8MM) ? 1 : 0;
        }
#    elif defined(HWCAP_I8MM)
        f->has_i8mm = (hw & HWCAP_I8MM) ? 1 : 0;
#    endif
        (void)hw;
    }
#  elif defined(__ARM_FEATURE_DOTPROD)
    f->has_dotprod = 1;
#    if defined(__ARM_FEATURE_MATMUL_INT8)
    f->has_i8mm = 1;
#    endif
#  endif
#endif

#if defined(POLAR_ARCH_RISCV) && defined(__linux__)
    /* Prefer the modern riscv_hwprobe(2) syscall: it returns granular
     * ISA-extension bits (V, Zvfh, Zba, ...) and is the only reliable
     * way to detect RVV 1.0. Fall back to AT_HWCAP's coarse 'V' bit on
     * kernels that predate hwprobe(2) (< 6.4). Wave 1 only wires
     * detection; the dispatcher branches arrive with Wave 3. */
#  if defined(POLAR_HAS_HWPROBE) && defined(RISCV_HWPROBE_KEY_IMA_EXT_0)
    {
        struct riscv_hwprobe pairs[1] = {
            { .key = RISCV_HWPROBE_KEY_IMA_EXT_0, .value = 0 },
        };
        if (__riscv_hwprobe(pairs, 1, 0, NULL, 0) == 0) {
#    if defined(RISCV_HWPROBE_IMA_V)
            if (pairs[0].value & RISCV_HWPROBE_IMA_V) f->has_rvv = 1;
#    endif
#    if defined(RISCV_HWPROBE_EXT_ZVFH)
            if (pairs[0].value & RISCV_HWPROBE_EXT_ZVFH) f->has_rvv_zvfh = 1;
#    endif
        }
    }
#  endif
#  if defined(POLAR_HAS_AUXV)
    if (!f->has_rvv) {
        unsigned long rvhw = getauxval(AT_HWCAP);
#    if defined(COMPAT_HWCAP_ISA_V)
        if (rvhw & COMPAT_HWCAP_ISA_V) f->has_rvv = 1;
#    elif defined(HWCAP_ISA_V)
        if (rvhw & HWCAP_ISA_V) f->has_rvv = 1;
#    elif defined(HWCAP_V)
        if (rvhw & HWCAP_V) f->has_rvv = 1;
#    endif
        (void)rvhw;
    }
#  endif
#endif
}

#endif /* POLAR_CPU_FEATURES_H */
