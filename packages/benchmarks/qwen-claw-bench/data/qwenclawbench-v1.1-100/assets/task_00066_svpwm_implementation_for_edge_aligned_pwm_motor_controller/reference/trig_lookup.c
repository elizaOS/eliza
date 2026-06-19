/**
 * @file    trig_lookup.c
 * @brief   Sine/Cosine lookup table with linear interpolation
 * @version 1.0
 * @date    2024-01-08
 *
 * 256-entry sine table in Q15 fixed-point format.
 * Angle input range: 0 to 65535 (maps to 0 to 2*pi).
 * Output range: -32768 to 32767 (Q15: -1.0 to +0.99997).
 *
 * Usage:
 *   int16_t s = sin_lookup(angle_u16);
 *   int16_t c = cos_lookup(angle_u16);
 */

#include <stdint.h>

/* Number of entries in the sine table (one full quadrant would be 64, full cycle = 256) */
#define SINE_TABLE_SIZE  256

/**
 * @brief Sine lookup table, 256 entries, Q15 fixed-point
 *        Index i corresponds to angle = i * (360/256) degrees = i * (2*pi/256) radians
 */
static const int16_t sine_table[SINE_TABLE_SIZE] = {
         0,    804,   1608,   2410,   3212,   4011,   4808,   5602,  /* [  0..  7] */
      6393,   7179,   7962,   8739,   9512,  10278,  11039,  11793,  /* [  8.. 15] */
     12539,  13279,  14010,  14732,  15446,  16151,  16846,  17530,  /* [ 16.. 23] */
     18204,  18868,  19519,  20159,  20787,  21403,  22005,  22594,  /* [ 24.. 31] */
     23170,  23731,  24279,  24811,  25329,  25832,  26319,  26790,  /* [ 32.. 39] */
     27245,  27683,  28105,  28510,  28898,  29268,  29621,  29956,  /* [ 40.. 47] */
     30273,  30571,  30852,  31113,  31356,  31580,  31785,  31971,  /* [ 48.. 55] */
     32137,  32285,  32412,  32521,  32609,  32678,  32728,  32757,  /* [ 56.. 63] */
     32767,  32757,  32728,  32678,  32609,  32521,  32412,  32285,  /* [ 64.. 71] */
     32137,  31971,  31785,  31580,  31356,  31113,  30852,  30571,  /* [ 72.. 79] */
     30273,  29956,  29621,  29268,  28898,  28510,  28105,  27683,  /* [ 80.. 87] */
     27245,  26790,  26319,  25832,  25329,  24811,  24279,  23731,  /* [ 88.. 95] */
     23170,  22594,  22005,  21403,  20787,  20159,  19519,  18868,  /* [ 96..103] */
     18204,  17530,  16846,  16151,  15446,  14732,  14010,  13279,  /* [104..111] */
     12539,  11793,  11039,  10278,   9512,   8739,   7962,   7179,  /* [112..119] */
      6393,   5602,   4808,   4011,   3212,   2410,   1608,    804,  /* [120..127] */
         0,   -804,  -1608,  -2410,  -3212,  -4011,  -4808,  -5602,  /* [128..135] */
     -6393,  -7179,  -7962,  -8739,  -9512, -10278, -11039, -11793,  /* [136..143] */
    -12539, -13279, -14010, -14732, -15446, -16151, -16846, -17530,  /* [144..151] */
    -18204, -18868, -19519, -20159, -20787, -21403, -22005, -22594,  /* [152..159] */
    -23170, -23731, -24279, -24811, -25329, -25832, -26319, -26790,  /* [160..167] */
    -27245, -27683, -28105, -28510, -28898, -29268, -29621, -29956,  /* [168..175] */
    -30273, -30571, -30852, -31113, -31356, -31580, -31785, -31971,  /* [176..183] */
    -32137, -32285, -32412, -32521, -32609, -32678, -32728, -32757,  /* [184..191] */
    -32767, -32757, -32728, -32678, -32609, -32521, -32412, -32285,  /* [192..199] */
    -32137, -31971, -31785, -31580, -31356, -31113, -30852, -30571,  /* [200..207] */
    -30273, -29956, -29621, -29268, -28898, -28510, -28105, -27683,  /* [208..215] */
    -27245, -26790, -26319, -25832, -25329, -24811, -24279, -23731,  /* [216..223] */
    -23170, -22594, -22005, -21403, -20787, -20159, -19519, -18868,  /* [224..231] */
    -18204, -17530, -16846, -16151, -15446, -14732, -14010, -13279,  /* [232..239] */
    -12539, -11793, -11039, -10278,  -9512,  -8739,  -7962,  -7179,  /* [240..247] */
     -6393,  -5602,  -4808,  -4011,  -3212,  -2410,  -1608,   -804  /* [248..255] */
};

/**
 * @brief  Sine lookup with linear interpolation
 *
 * @param  angle  Angle in uint16 format: 0 = 0 deg, 65535 = ~360 deg
 * @return int16_t  Sine value in Q15 format (-32768 to 32767)
 */
int16_t sin_lookup(uint16_t angle)
{
    /* Upper 8 bits = table index, lower 8 bits = fractional part */
    uint8_t  index = (uint8_t)(angle >> 8);
    uint8_t  frac  = (uint8_t)(angle & 0xFF);

    int16_t val0 = sine_table[index];
    int16_t val1 = sine_table[(uint8_t)(index + 1)];  /* wraps naturally for uint8 */

    /* Linear interpolation: result = val0 + frac/256 * (val1 - val0) */
    int32_t diff = (int32_t)val1 - (int32_t)val0;
    int32_t result = (int32_t)val0 + ((diff * (int32_t)frac) >> 8);

    return (int16_t)result;
}

/**
 * @brief  Cosine lookup with linear interpolation
 *
 * @param  angle  Angle in uint16 format: 0 = 0 deg, 65535 = ~360 deg
 * @return int16_t  Cosine value in Q15 format (-32768 to 32767)
 *
 * cos(x) = sin(x + 90°) = sin(x + 16384)
 */
int16_t cos_lookup(uint16_t angle)
{
    /* Add 90 degrees (65536/4 = 16384) and use sine table */
    return sin_lookup(angle + 16384u);
}

/**
 * @brief  Convert Q15 value to float (for debugging/testing)
 *
 * @param  q15_val  Q15 fixed-point value
 * @return float    Floating-point equivalent
 */
float q15_to_float(int16_t q15_val)
{
    return (float)q15_val / 32768.0f;
}

/**
 * @brief  Convert float to Q15 (for debugging/testing)
 *
 * @param  f  Floating-point value in range [-1.0, +1.0)
 * @return int16_t  Q15 fixed-point equivalent
 */
int16_t float_to_q15(float f)
{
    if (f >= 1.0f)  return 32767;
    if (f < -1.0f)  return -32768;
    return (int16_t)(f * 32768.0f);
}
