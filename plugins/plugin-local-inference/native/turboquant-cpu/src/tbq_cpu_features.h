/*
 * Runtime CPU feature detection for the TurboQuant CPU dispatch table.
 *
 * The CMake build still compiles each SIMD TU only for arches whose
 * intrinsics exist (AVX2 on x86_64, NEON on AArch64, RVV 1.0 on
 * riscv64) and sets TBQ_HAVE_* so the dispatcher knows which symbols
 * were linked. Within a build, the actual choice is made at runtime
 * from cpuid / hwcap / hwprobe.
 *
 * Mirrors qjl_cpu_features.h and polar_cpu_features.h so the three
 * packages share the same detection plumbing.
 */
#ifndef TBQ_CPU_FEATURES_H
#define TBQ_CPU_FEATURES_H

#include <stdint.h>

#if defined(__x86_64__) || defined(__i386__) || defined(_M_X64) || defined(_M_IX86)
#  define TBQ_ARCH_X86 1
#  if defined(_MSC_VER)
#    include <intrin.h>
#  else
#    include <cpuid.h>
#  endif
#endif

#if defined(__aarch64__) || defined(__arm64__)
#  define TBQ_ARCH_ARM64 1
#  if defined(__linux__)
#    include <sys/auxv.h>
#    include <asm/hwcap.h>
#  endif
#endif

#if defined(__riscv) && (__riscv_xlen == 64)
#  ifndef TBQ_ARCH_RISCV
#    define TBQ_ARCH_RISCV 1
#  endif
#  if defined(__has_include)
#    if __has_include(<sys/hwprobe.h>)
#      include <sys/hwprobe.h>
#      define TBQ_HAS_HWPROBE 1
#    endif
#    if __has_include(<sys/auxv.h>)
#      include <sys/auxv.h>
#      define TBQ_HAS_AUXV 1
#    endif
#    if __has_include(<asm/hwcap.h>)
#      include <asm/hwcap.h>
#    endif
#  endif
#endif

typedef struct {
    unsigned int has_avx2 : 1;
    unsigned int has_avx_vnni : 1;
    unsigned int has_neon : 1;
    unsigned int has_dotprod : 1;
    unsigned int has_rvv : 1;
    unsigned int has_rvv_zvfh : 1;
} tbq_cpu_features_t;

static inline void tbq_detect_cpu(tbq_cpu_features_t *f) {
    f->has_avx2 = 0;
    f->has_avx_vnni = 0;
    f->has_neon = 0;
    f->has_dotprod = 0;
    f->has_rvv = 0;
    f->has_rvv_zvfh = 0;

#if defined(TBQ_ARCH_X86)
    {
        unsigned int eax, ebx, ecx, edx;
#  if defined(_MSC_VER)
        int regs[4];
        __cpuidex(regs, 7, 0);
        ebx = (unsigned)regs[1];
        f->has_avx2 = (ebx >> 5) & 1;
        __cpuidex(regs, 7, 1);
        eax = (unsigned)regs[0];
        f->has_avx_vnni = (eax >> 4) & 1;
#  else
        if (__get_cpuid_count(7, 0, &eax, &ebx, &ecx, &edx)) {
            f->has_avx2 = (ebx >> 5) & 1;
        }
        if (__get_cpuid_count(7, 1, &eax, &ebx, &ecx, &edx)) {
            f->has_avx_vnni = (eax >> 4) & 1;
        }
#  endif
    }
#endif

#if defined(TBQ_ARCH_ARM64)
    f->has_neon = 1;
#  if defined(__linux__)
    {
        unsigned long hw = getauxval(AT_HWCAP);
#    ifdef HWCAP_ASIMDDP
        f->has_dotprod = (hw & HWCAP_ASIMDDP) ? 1 : 0;
#    endif
        (void)hw;
    }
#  elif defined(__ARM_FEATURE_DOTPROD)
    f->has_dotprod = 1;
#  endif
#endif

#if defined(TBQ_ARCH_RISCV) && defined(__linux__)
    /* Prefer the modern riscv_hwprobe(2) syscall: it returns granular
     * ISA-extension bits (V, Zvfh, ...) and is the only reliable way to
     * detect RVV 1.0. Fall back to AT_HWCAP's coarse 'V' bit on kernels
     * that predate hwprobe(2) (< 6.4). Both stay best-effort: if neither
     * header / runtime is present we leave the probe bits 0 and the
     * dispatcher uses the scalar reference path. */
#  if defined(TBQ_HAS_HWPROBE) && defined(RISCV_HWPROBE_KEY_IMA_EXT_0)
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
#  if defined(TBQ_HAS_AUXV)
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

/* SIMD enumeration for the dispatcher. NEON / AVX2 entries are listed
 * even though no NEON / AVX2 TU exists yet (they will land in follow-up
 * tasks) so the dispatch shape stays stable. */
typedef enum tbq_simd_e {
    TBQ_SIMD_REF = 0,
    TBQ_SIMD_NEON,
    TBQ_SIMD_AVX2,
    TBQ_SIMD_RVV,
} tbq_simd_t;

/* Note: the public introspection / override API (`tbq_active_simd`,
 * `tbq_force_simd`) is declared in turboquant.h. The dispatcher
 * implementation includes both headers. */

#endif /* TBQ_CPU_FEATURES_H */
