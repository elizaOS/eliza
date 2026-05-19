/*
 * Runtime CPU feature detection for the QJL CPU dispatch table.
 *
 * The build still compiles each SIMD TU only for arches where its
 * intrinsics exist (AVX2/AVX-VNNI on x86_64, NEON / dot-product on
 * AArch64), but the dispatcher picks the best *available* path at
 * runtime via cpuid / hwcap so a binary built with AVX-VNNI support
 * still runs on an AVX2-only host (and a NEON-only host doesn't trap
 * on a `vdotq_s32`).
 */
#ifndef QJL_CPU_FEATURES_H
#define QJL_CPU_FEATURES_H

#include <stdint.h>

#if defined(__x86_64__) || defined(__i386__) || defined(_M_X64) || defined(_M_IX86)
#  define QJL_ARCH_X86 1
#  if defined(_MSC_VER)
#    include <intrin.h>
#  else
#    include <cpuid.h>
#  endif
#endif

#if defined(__aarch64__) || defined(__arm64__)
#  define QJL_ARCH_ARM64 1
#  if defined(__linux__)
#    include <sys/auxv.h>
#    include <asm/hwcap.h>
#  endif
#endif

typedef struct {
    int has_avx2;
    int has_fma;
    int has_avx_vnni;   /* 256-bit VPDPBUSD via AVX-VNNI (Alder Lake+) */
    int has_neon;       /* always 1 on AArch64 */
    int has_dotprod;    /* ARMv8.4 SDOT/UDOT */
    int has_i8mm;       /* ARMv8.6 int8 matrix multiply */
} qjl_cpu_features_t;

static inline void qjl_detect_cpu(qjl_cpu_features_t *f) {
    f->has_avx2 = f->has_fma = f->has_avx_vnni = 0;
    f->has_neon = f->has_dotprod = f->has_i8mm = 0;

#if defined(QJL_ARCH_X86)
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

#if defined(QJL_ARCH_ARM64)
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
}

#endif /* QJL_CPU_FEATURES_H */
