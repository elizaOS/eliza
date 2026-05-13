/**
 * @file    clarke_park_transforms.c
 * @brief   Clarke and Inverse Clarke transform implementations
 * @version 1.2
 * @date    2024-02-10
 *
 * Clarke Transform (abc -> alpha-beta):
 *   Equal-amplitude variant for balanced three-phase systems.
 *
 *   Valpha = Va
 *   Vbeta  = (Va + 2*Vb) / sqrt(3)
 *
 * Inverse Clarke Transform (alpha-beta -> abc):
 *   Va = Valpha
 *   Vb = (-Valpha + sqrt(3)*Vbeta) / 2
 *   Vc = (-Valpha - sqrt(3)*Vbeta) / 2
 *
 * Note: These transforms assume a balanced system where Va + Vb + Vc = 0.
 */

#include <math.h>

#ifndef SQRT3
#define SQRT3       1.7320508075688772f
#endif

#ifndef INV_SQRT3
#define INV_SQRT3   0.5773502691896258f   /* 1/sqrt(3) */
#endif

/**
 * @brief Two-component vector in alpha-beta frame
 */
typedef struct {
    float alpha;
    float beta;
} AlphaBeta_t;

/**
 * @brief Three-phase quantities
 */
typedef struct {
    float a;
    float b;
    float c;
} ABC_t;

/**
 * @brief  Clarke transform: abc -> alpha-beta
 *
 * @param  input   Pointer to three-phase input (Va, Vb, Vc)
 * @param  output  Pointer to alpha-beta output
 *
 * Formulas:
 *   Valpha = Va
 *   Vbeta  = (Va + 2*Vb) / sqrt(3)
 */
void clarke_transform(const ABC_t *input, AlphaBeta_t *output)
{
    output->alpha = input->a;
    output->beta  = (input->a + 2.0f * input->b) * INV_SQRT3;
}

/**
 * @brief  Inverse Clarke transform: alpha-beta -> abc
 *
 * @param  input   Pointer to alpha-beta input
 * @param  output  Pointer to three-phase output (Va, Vb, Vc)
 *
 * Formulas:
 *   Va = Valpha
 *   Vb = (-Valpha + sqrt(3)*Vbeta) / 2
 *   Vc = (-Valpha - sqrt(3)*Vbeta) / 2
 */
void inverse_clarke_transform(const AlphaBeta_t *input, ABC_t *output)
{
    output->a = input->alpha;
    output->b = (-input->alpha + SQRT3 * input->beta) * 0.5f;
    output->c = (-input->alpha - SQRT3 * input->beta) * 0.5f;
}

/**
 * @brief  Park transform: alpha-beta -> dq (rotating frame)
 *
 * @param  input   Pointer to alpha-beta input
 * @param  theta   Electrical angle in radians
 * @param  d       Pointer to d-axis output
 * @param  q       Pointer to q-axis output
 *
 * Formulas:
 *   Vd =  Valpha * cos(theta) + Vbeta * sin(theta)
 *   Vq = -Valpha * sin(theta) + Vbeta * cos(theta)
 */
void park_transform(const AlphaBeta_t *input, float theta, float *d, float *q)
{
    float cos_theta = cosf(theta);
    float sin_theta = sinf(theta);

    *d =  input->alpha * cos_theta + input->beta * sin_theta;
    *q = -input->alpha * sin_theta + input->beta * cos_theta;
}

/**
 * @brief  Inverse Park transform: dq -> alpha-beta
 *
 * @param  d       d-axis input
 * @param  q       q-axis input
 * @param  theta   Electrical angle in radians
 * @param  output  Pointer to alpha-beta output
 *
 * Formulas:
 *   Valpha = Vd * cos(theta) - Vq * sin(theta)
 *   Vbeta  = Vd * sin(theta) + Vq * cos(theta)
 */
void inverse_park_transform(float d, float q, float theta, AlphaBeta_t *output)
{
    float cos_theta = cosf(theta);
    float sin_theta = sinf(theta);

    output->alpha = d * cos_theta - q * sin_theta;
    output->beta  = d * sin_theta + q * cos_theta;
}
