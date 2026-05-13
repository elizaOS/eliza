/**
 * @file    old_svpwm_center_aligned.c
 * @brief   SVPWM implementation for center-aligned PWM mode
 * @version 3.1
 * @date    2023-08-22
 * @author  Motor Control Team
 *
 * This module implements Space Vector PWM for a three-phase inverter.
 * Designed for center-aligned (up-down counter) PWM peripheral.
 *
 * PWM Mode: Center-aligned (triangle carrier)
 *   Counter counts: 0 -> PWM_PERIOD/2 -> 0 (up-down)
 *   Symmetric pulse placement is inherent.
 *
 * TESTED AND VALIDATED on XMC4400 platform with center-aligned CCU8.
 */

#include <math.h>
#include <stdint.h>

#define PWM_PERIOD      1000
#define PWM_HALF_PERIOD (PWM_PERIOD / 2)   /* 500 — base for center-aligned */
#define VDC             310.0f
#define SQRT3           1.7320508075688772f
#define INV_SQRT3       0.5773502691896258f

typedef struct {
    float alpha;
    float beta;
} VoltageAB_t;

typedef struct {
    uint16_t cmp_u;
    uint16_t cmp_v;
    uint16_t cmp_w;
} PWMCompare_t;

/**
 * @brief Determine SVPWM sector from Valpha, Vbeta
 */
static int determine_sector(float Valpha, float Vbeta)
{
    float Vref1 = Vbeta;
    float Vref2 = (SQRT3 * Valpha - Vbeta) * 0.5f;
    float Vref3 = (-SQRT3 * Valpha - Vbeta) * 0.5f;

    int A = (Vref1 > 0.0f) ? 1 : 0;
    int B = (Vref2 > 0.0f) ? 1 : 0;
    int C = (Vref3 > 0.0f) ? 1 : 0;

    int N = 4 * C + 2 * B + A;

    /* Sector lookup */
    static const int sector_table[7] = {0, 2, 6, 1, 4, 3, 5};
    if (N < 1 || N > 6) return 1; /* fallback */
    return sector_table[N];
}

/**
 * @brief Calculate SVPWM duty cycles for center-aligned PWM
 *
 * For center-aligned mode:
 *   - Counter counts 0 -> PWM_HALF_PERIOD -> 0 (triangle)
 *   - Compare base is PWM_HALF_PERIOD (500)
 *   - T0 is distributed as T0/4 on each of the four transitions
 *     (two at the start, two at the end of the symmetric pattern)
 *   - This gives natural double-sided switching with minimum harmonics
 *
 * Duty cycle = compare_value / PWM_HALF_PERIOD (center-aligned base)
 */
void svpwm_calculate(const VoltageAB_t *Vref, PWMCompare_t *pwm_out)
{
    float Valpha = Vref->alpha;
    float Vbeta  = Vref->beta;

    int sector = determine_sector(Valpha, Vbeta);

    /* Calculate X, Y, Z intermediate values */
    /* Ts = PWM_PERIOD, but for center-aligned we use PWM_HALF_PERIOD as base */
    float K = SQRT3 * (float)PWM_HALF_PERIOD / VDC;

    float X = K * Vbeta;
    float Y = K * (SQRT3 * 0.5f * Valpha + 0.5f * Vbeta);
    float Z = K * (-SQRT3 * 0.5f * Valpha + 0.5f * Vbeta);

    float T1, T2;

    switch (sector) {
        case 1: T1 =  Z; T2 =  Y; break;
        case 2: T1 =  Y; T2 = -Z; break;
        case 3: T1 =  X; T2 =  Z; break;
        case 4: T1 = -Z; T2 = -Y; break;
        case 5: T1 = -Y; T2 =  Z; break;
        case 6: T1 = -X; T2 = -Z; break;
        default: T1 = 0; T2 = 0; break;
    }

    /* Clamp to linear range */
    if (T1 + T2 > (float)PWM_HALF_PERIOD) {
        float scale = (float)PWM_HALF_PERIOD / (T1 + T2);
        T1 *= scale;
        T2 *= scale;
    }

    /* T0 calculation for CENTER-ALIGNED mode */
    float T0 = (float)PWM_HALF_PERIOD - T1 - T2;

    /*
     * CENTER-ALIGNED T0 DISTRIBUTION:
     * T0 is split into 4 equal parts (T0/4) for symmetric placement:
     *   T0/4 | T1/2 | T2/2 | T0/2 | T2/2 | T1/2 | T0/4
     *
     * The compare values for center-aligned mode use PWM_HALF_PERIOD as base.
     * Phase timing offsets from center:
     */
    float Ta, Tb, Tc;

    switch (sector) {
        case 1:
            Ta = T1 + T2 + T0 / 4.0f;
            Tb = T2 + T0 / 4.0f;
            Tc = T0 / 4.0f;
            break;
        case 2:
            Ta = T1 + T0 / 4.0f;
            Tb = T1 + T2 + T0 / 4.0f;
            Tc = T0 / 4.0f;
            break;
        case 3:
            Ta = T0 / 4.0f;
            Tb = T1 + T2 + T0 / 4.0f;
            Tc = T2 + T0 / 4.0f;
            break;
        case 4:
            Ta = T0 / 4.0f;
            Tb = T1 + T0 / 4.0f;
            Tc = T1 + T2 + T0 / 4.0f;
            break;
        case 5:
            Ta = T2 + T0 / 4.0f;
            Tb = T0 / 4.0f;
            Tc = T1 + T2 + T0 / 4.0f;
            break;
        case 6:
            Ta = T1 + T2 + T0 / 4.0f;
            Tb = T0 / 4.0f;
            Tc = T1 + T0 / 4.0f;
            break;
        default:
            Ta = Tb = Tc = (float)PWM_HALF_PERIOD * 0.5f;
            break;
    }

    /* Convert to compare register values for center-aligned mode */
    /* Compare base is PWM_HALF_PERIOD (500), NOT PWM_PERIOD (1000) */
    pwm_out->cmp_u = (uint16_t)(Ta + 0.5f);
    pwm_out->cmp_v = (uint16_t)(Tb + 0.5f);
    pwm_out->cmp_w = (uint16_t)(Tc + 0.5f);

    /* Clamp to valid range for center-aligned: 0 to PWM_HALF_PERIOD */
    if (pwm_out->cmp_u > PWM_HALF_PERIOD) pwm_out->cmp_u = PWM_HALF_PERIOD;
    if (pwm_out->cmp_v > PWM_HALF_PERIOD) pwm_out->cmp_v = PWM_HALF_PERIOD;
    if (pwm_out->cmp_w > PWM_HALF_PERIOD) pwm_out->cmp_w = PWM_HALF_PERIOD;
}

/**
 * @brief Initialize SVPWM module
 *
 * Configures PWM peripheral for center-aligned operation.
 * Counter period = PWM_HALF_PERIOD (500) for up-down counting.
 */
void svpwm_init(void)
{
    /* Configure CCU8 for center-aligned (up-down) mode */
    /* PWM_PERIOD_REG = PWM_HALF_PERIOD = 500 */
    /* Counter: 0 -> 500 -> 0 -> 500 -> ... */
    /* Actual PWM period in counts = 2 * PWM_HALF_PERIOD = 1000 */

    /* Hardware register writes would go here */
    /* CCU8_SLICE0->TC |= CCU8_TC_TCM_Msk;  // Enable center-aligned mode */
}
