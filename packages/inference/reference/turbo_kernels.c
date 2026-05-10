/* DRAFT: NOT VALIDATED ON HARDWARE — see kernels/README.md
 *
 * Reference C implementation that mirrors the buun-llama-cpp CUDA / Metal
 * paths bit-for-bit (same FWHT, same codebooks, same packing). Verification
 * harnesses link this and compare shader output against eliza_dot_q_*().
 *
 * This is intentionally simple and slow (no SIMD, no parallel Viterbi). It
 * exists to drive test fixtures, not production inference.
 */

#include "turbo_kernels.h"

#include <math.h>
#include <string.h>
#include <float.h>

/* ---------- fp16 helpers ---------- */

uint16_t eliza_fp32_to_fp16(float f) {
    union { float f; uint32_t u; } v = { f };
    uint32_t u = v.u;
    uint32_t sign = (u >> 16) & 0x8000;
    uint32_t exp  = (u >> 23) & 0xff;
    uint32_t mant = u & 0x7fffff;
    if (exp == 0xff) {
        return (uint16_t)(sign | 0x7c00 | (mant ? 0x200 : 0));
    }
    int32_t e = (int32_t)exp - 127 + 15;
    if (e >= 31) return (uint16_t)(sign | 0x7c00);
    if (e <= 0) {
        if (e < -10) return (uint16_t)sign;
        mant |= 0x800000;
        uint32_t shift = (uint32_t)(14 - e);
        uint16_t result = (uint16_t)(sign | (mant >> shift));
        if ((mant >> (shift - 1)) & 1) result++;
        return result;
    }
    uint16_t result = (uint16_t)(sign | (uint32_t)(e << 10) | (mant >> 13));
    if (mant & 0x1000) result++;
    return result;
}

float eliza_fp16_to_fp32(uint16_t h) {
    uint32_t sign = (uint32_t)(h & 0x8000) << 16;
    uint32_t exp  = (h >> 10) & 0x1f;
    uint32_t mant = h & 0x3ff;
    uint32_t u;
    if (exp == 0) {
        if (mant == 0) {
            u = sign;
        } else {
            while (!(mant & 0x400)) { mant <<= 1; exp--; }
            mant &= 0x3ff;
            u = sign | (((uint32_t)(exp + 127 - 15 + 1)) << 23) | (mant << 13);
        }
    } else if (exp == 0x1f) {
        u = sign | 0x7f800000 | (mant << 13);
    } else {
        u = sign | (((uint32_t)(exp + 127 - 15)) << 23) | (mant << 13);
    }
    union { uint32_t u; float f; } v = { u };
    return v.f;
}

/* ---------- constants (verbatim from CUDA / Metal sources) ---------- */

const float ELIZA_TURBO_CENTROIDS_3BIT[8] = {
    -0.190685f, -0.117832f, -0.065717f, -0.021460f,
     0.021460f,  0.065717f,  0.117832f,  0.190685f,
};
const float ELIZA_TURBO_MID_3BIT[7] = {
    -0.154259f, -0.091775f, -0.043589f, 0.0f, 0.043589f, 0.091775f, 0.154259f,
};
const float ELIZA_TURBO_CENTROIDS_4BIT[16] = {
    -0.241556f, -0.182907f, -0.143047f, -0.111065f,
    -0.083317f, -0.058069f, -0.034311f, -0.011353f,
     0.011353f,  0.034311f,  0.058069f,  0.083317f,
     0.111065f,  0.143047f,  0.182907f,  0.241556f,
};
const float ELIZA_TURBO_MID_4BIT[15] = {
    -0.212232f, -0.162977f, -0.127056f, -0.097191f, -0.070693f,
    -0.046190f, -0.022832f,  0.000000f,  0.022832f,  0.046190f,
     0.070693f,  0.097191f,  0.127056f,  0.162977f,  0.212232f,
};

/* From ggml-metal/turbo-wht.h — seed=42 sign vectors. */
const float ELIZA_TURBO_WHT_SIGNS1[128] = {
    -1.0f, 1.0f, 1.0f, -1.0f, -1.0f, 1.0f, -1.0f, 1.0f, -1.0f, -1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f,
    1.0f, -1.0f, 1.0f, -1.0f, 1.0f, -1.0f, -1.0f, 1.0f, 1.0f, 1.0f, -1.0f, 1.0f, 1.0f, -1.0f, -1.0f, -1.0f,
    -1.0f, 1.0f, 1.0f, -1.0f, 1.0f, 1.0f, -1.0f, 1.0f, -1.0f, 1.0f, 1.0f, -1.0f, -1.0f, 1.0f, -1.0f, 1.0f,
    1.0f, 1.0f, 1.0f, -1.0f, -1.0f, -1.0f, -1.0f, -1.0f, 1.0f, -1.0f, 1.0f, 1.0f, 1.0f, 1.0f, -1.0f, 1.0f,
    -1.0f, -1.0f, 1.0f, -1.0f, -1.0f, -1.0f, 1.0f, -1.0f, -1.0f, -1.0f, 1.0f, -1.0f, -1.0f, -1.0f, 1.0f, 1.0f,
    1.0f, -1.0f, -1.0f, 1.0f, 1.0f, 1.0f, -1.0f, -1.0f, 1.0f, 1.0f, -1.0f, 1.0f, 1.0f, -1.0f, 1.0f, -1.0f,
    -1.0f, 1.0f, 1.0f, -1.0f, 1.0f, -1.0f, 1.0f, -1.0f, 1.0f, 1.0f, 1.0f, 1.0f, -1.0f, 1.0f, -1.0f, 1.0f,
    1.0f, -1.0f, 1.0f, 1.0f, -1.0f, -1.0f, -1.0f, -1.0f, -1.0f, 1.0f, 1.0f, -1.0f, 1.0f, 1.0f, -1.0f, 1.0f,
};
const float ELIZA_TURBO_WHT_SIGNS2[128] = {
    1.0f, 1.0f, 1.0f, 1.0f, -1.0f, 1.0f, 1.0f, -1.0f, 1.0f, -1.0f, -1.0f, -1.0f, 1.0f, -1.0f, -1.0f, -1.0f,
    1.0f, 1.0f, -1.0f, -1.0f, 1.0f, -1.0f, 1.0f, -1.0f, 1.0f, -1.0f, -1.0f, 1.0f, -1.0f, 1.0f, 1.0f, 1.0f,
    1.0f, 1.0f, -1.0f, -1.0f, -1.0f, 1.0f, -1.0f, -1.0f, -1.0f, -1.0f, -1.0f, -1.0f, 1.0f, 1.0f, 1.0f, -1.0f,
    1.0f, -1.0f, 1.0f, 1.0f, 1.0f, -1.0f, -1.0f, 1.0f, -1.0f, -1.0f, -1.0f, -1.0f, -1.0f, -1.0f, 1.0f, 1.0f,
    1.0f, -1.0f, 1.0f, -1.0f, -1.0f, -1.0f, -1.0f, 1.0f, -1.0f, 1.0f, -1.0f, 1.0f, -1.0f, -1.0f, 1.0f, 1.0f,
    -1.0f, 1.0f, -1.0f, 1.0f, 1.0f, -1.0f, 1.0f, -1.0f, -1.0f, -1.0f, -1.0f, 1.0f, -1.0f, -1.0f, 1.0f, -1.0f,
    1.0f, -1.0f, 1.0f, 1.0f, 1.0f, -1.0f, -1.0f, 1.0f, -1.0f, 1.0f, -1.0f, 1.0f, 1.0f, -1.0f, -1.0f, 1.0f,
    -1.0f, 1.0f, -1.0f, 1.0f, 1.0f, -1.0f, 1.0f, -1.0f, 1.0f, -1.0f, -1.0f, -1.0f, -1.0f, -1.0f, 1.0f, -1.0f,
};

/* turbo3_tcq codebook — verbatim from
 * ggml-cuda/turbo-quant-cuda.cuh d_turbo3_tcq_codebook[512].
 * If you copy these, credit spiritbuun. */
const float ELIZA_TURBO3_TCQ_CODEBOOK[512] = {
    -0.14559399f, -0.09062801f, -0.054925077f, -0.03699251f, -0.006363985f, +0.026264573f, +0.067378916f, +0.121981815f,
    -0.18648055f, -0.106522456f, -0.052047577f, -0.011695214f, +0.021953275f, +0.059698727f, +0.09831437f, +0.16083933f,
    -0.16390342f, -0.12639847f, -0.09513180f, -0.05938352f, -0.028396897f, +0.005973862f, +0.049104784f, +0.11334257f,
    -0.25952467f, -0.079778515f, -0.036024813f, +0.0003641268f, +0.031858794f, +0.073280424f, +0.11835553f, +0.19738495f,
    -0.14218009f, -0.10224814f, -0.062498566f, -0.027066832f, +0.00393002f, +0.04069300f, +0.08257346f, +0.14548601f,
    -0.18673635f, -0.13438253f, -0.088401966f, -0.05205436f, -0.02032501f, +0.012399545f, +0.05127183f, +0.10316186f,
    -0.10807011f, -0.065903045f, -0.032206114f, -0.0062006037f, +0.020679146f, +0.04422085f, +0.08313074f, +0.16821936f,
    -0.22979105f, -0.14431947f, -0.07689272f, -0.02755307f, +0.009225173f, +0.046684854f, +0.08834142f, +0.13766693f,
    -0.22114082f, -0.12612148f, -0.06890522f, -0.016128855f, +0.03691900f, +0.08474852f, +0.14940020f, +0.23229980f,
    -0.14933491f, -0.099693604f, -0.06738499f, -0.037100967f, -0.009332986f, +0.023535024f, +0.060272533f, +0.109464675f,
    -0.20200425f, -0.07398328f, -0.038700905f, -0.01714807f, +0.011161969f, +0.04528101f, +0.08902637f, +0.19573534f,
    -0.16645233f, -0.124482535f, -0.089342155f, -0.04427387f, -0.007353691f, +0.028033108f, +0.066108435f, +0.15552913f,
    -0.22295763f, -0.059887577f, -0.018804537f, +0.020141022f, +0.059682943f, +0.097920544f, +0.14080113f, +0.25698325f,
    -0.14248224f, -0.089685425f, -0.050101686f, -0.017257255f, +0.011412255f, +0.040830314f, +0.07400172f, +0.11997315f,
    -0.18649384f, -0.113997504f, -0.067775466f, -0.033394672f, +0.006586988f, +0.05312057f, +0.10433043f, +0.22344802f,
    -0.16138338f, -0.108194515f, -0.07600300f, -0.05135381f, -0.023365447f, +0.0087320795f, +0.045431953f, +0.09113002f,
    -0.12630440f, -0.07225349f, -0.032280035f, +0.0029231994f, +0.019239848f, +0.05081419f, +0.077840395f, +0.121695265f,
    -0.08928155f, -0.044983763f, -0.009889568f, +0.020831043f, +0.05684458f, +0.09409702f, +0.13867535f, +0.19084482f,
    -0.14182915f, -0.11380146f, -0.06904074f, -0.002002765f, +0.034864165f, +0.070399575f, +0.11403063f, +0.15394832f,
    -0.10876417f, -0.056122433f, -0.02267638f, +0.011113975f, +0.039639056f, +0.074084364f, +0.10155376f, +0.12540291f,
    -0.17693359f, -0.13940524f, -0.10049578f, -0.06796275f, -0.036915872f, +0.00062823476f, +0.042142134f, +0.17906062f,
    -0.09253492f, -0.04290128f, -0.006311852f, +0.023908244f, +0.049849935f, +0.078770354f, +0.10818172f, +0.15166481f,
    -0.12429565f, -0.07392063f, -0.029114135f, +0.0059440783f, +0.042675965f, +0.08425635f, +0.13836108f, +0.18634140f,
    -0.11795639f, -0.07033707f, -0.034163877f, -0.0008773357f, +0.03334606f, +0.07188203f, +0.12216825f, +0.17097956f,
    -0.18718453f, -0.14090346f, -0.097799584f, -0.059522875f, -0.019208657f, +0.03079176f, +0.09334672f, +0.15811224f,
    -0.27198875f, -0.16546582f, -0.11433405f, -0.06933013f, -0.04026183f, -0.0061146915f, +0.029263576f, +0.07322499f,
    -0.18471734f, -0.102074504f, -0.06492570f, -0.034418534f, -0.009636157f, +0.023043344f, +0.05751496f, +0.09905984f,
    -0.22826399f, -0.15946552f, -0.09913176f, -0.06585259f, -0.03252090f, +0.001313243f, +0.03556729f, +0.21612854f,
    -0.13243781f, -0.087299444f, -0.049820945f, -0.016216082f, +0.01799807f, +0.057916876f, +0.09001349f, +0.13221787f,
    -0.19516511f, -0.120894566f, -0.076130204f, -0.051442243f, -0.029535033f, -0.0020043184f, +0.029452588f, +0.075566076f,
    -0.27272871f, -0.15841717f, -0.105432935f, -0.06792948f, -0.024532158f, +0.014960791f, +0.054415092f, +0.101517834f,
    -0.21153601f, -0.15015371f, -0.08676790f, -0.04414934f, -0.0042129597f, +0.033762872f, +0.07589151f, +0.12768789f,
    -0.090428725f, -0.037582967f, +0.0013173596f, +0.03900247f, +0.06840049f, +0.116906695f, +0.16584939f, +0.25382105f,
    -0.13446195f, -0.07865091f, -0.039625354f, -0.0028398742f, +0.03019514f, +0.06799379f, +0.11850997f, +0.17521496f,
    -0.11350345f, -0.058599845f, -0.017512511f, +0.019431496f, +0.055897832f, +0.093173414f, +0.14820710f, +0.22092152f,
    -0.15165758f, -0.08869354f, -0.04974287f, -0.01705474f, +0.013134752f, +0.04367713f, +0.07733791f, +0.12430801f,
    -0.09329869f, -0.04673005f, -0.00045857552f, +0.042781368f, +0.07802363f, +0.11887439f, +0.16250038f, +0.28612965f,
    -0.12571070f, -0.07786012f, -0.03843933f, -0.0075433915f, +0.025822964f, +0.066053316f, +0.12021536f, +0.18341768f,
    -0.16079275f, -0.04921760f, -0.006114644f, +0.026215268f, +0.05699377f, +0.09813471f, +0.16080129f, +0.23786584f,
    -0.09980837f, -0.048535258f, -0.0096120685f, +0.025387142f, +0.05979822f, +0.09875251f, +0.14474337f, +0.20324114f,
    -0.15846540f, -0.09938028f, -0.061492465f, -0.03523542f, -0.0061364113f, +0.024916094f, +0.06037314f, +0.106796466f,
    -0.20557843f, -0.123237535f, -0.07734871f, -0.044549115f, -0.017114898f, +0.01616654f, +0.049574375f, +0.092319444f,
    -0.19221115f, -0.14642999f, -0.091701314f, -0.055265956f, -0.021026207f, +0.017720066f, +0.05786183f, +0.110154524f,
    -0.09956386f, -0.03870283f, +0.003052007f, +0.034851722f, +0.06256365f, +0.09628840f, +0.13979156f, +0.16582295f,
    -0.18026546f, -0.12448310f, -0.07424377f, -0.03954519f, -0.01221123f, +0.028641058f, +0.100819774f, +0.18240699f,
    -0.21520759f, -0.15573645f, -0.09820838f, -0.051450998f, -0.012993679f, +0.021135861f, +0.058727216f, +0.105848536f,
    -0.11207385f, -0.08335689f, -0.048542723f, -0.023198519f, +0.0039304253f, +0.037778318f, +0.07813917f, +0.13106476f,
    -0.17849164f, -0.120988995f, -0.078016765f, -0.043093704f, -0.016565649f, +0.015182641f, +0.050754096f, +0.09595712f,
    -0.22132620f, -0.13407415f, -0.065785654f, -0.013291034f, +0.032098345f, +0.07478225f, +0.12431934f, +0.19174045f,
    -0.095454164f, -0.051898945f, -0.015116375f, -0.012596778f, +0.018636847f, +0.05006925f, +0.087654814f, +0.13754296f,
    -0.15254061f, -0.09576059f, -0.052086458f, -0.01596074f, +0.017607626f, +0.04778498f, +0.08950204f, +0.14901252f,
    -0.26057002f, -0.12472382f, -0.074396215f, -0.03764066f, +0.0011168446f, +0.061569117f, +0.10793752f, +0.19771695f,
    -0.08661132f, -0.045195263f, -0.016098704f, +0.012780116f, +0.040476497f, +0.074102715f, +0.074102715f, +0.12635531f,
    -0.14047913f, -0.059587404f, -0.016261123f, +0.019801628f, +0.053541403f, +0.096650146f, +0.15005490f, +0.21051759f,
    -0.22986396f, -0.11964334f, -0.07266585f, -0.026522418f, +0.018169926f, +0.058630653f, +0.100647695f, +0.15919648f,
    -0.13251697f, -0.077567816f, -0.042766172f, -0.011389967f, +0.01831755f, +0.05304656f, +0.09620367f, +0.15567583f,
    -0.119819686f, -0.06772876f, -0.028123451f, +0.00876240f, +0.014405836f, +0.048829112f, +0.08422175f, +0.13823749f,
    -0.16379014f, -0.08956941f, -0.041652776f, +0.008921398f, +0.05473602f, +0.10037984f, +0.16022855f, +0.23457925f,
    -0.115844205f, -0.05939626f, -0.020390417f, +0.01374377f, +0.044976473f, +0.07873563f, +0.12207942f, +0.18412720f,
    -0.19048831f, -0.07587487f, -0.03220580f, -0.00011795067f, +0.02721784f, +0.04380719f, +0.07886723f, +0.13193911f,
    -0.13935551f, -0.092902906f, -0.052706074f, -0.017797327f, +0.015312965f, +0.056098964f, +0.11203423f, +0.24448302f,
    -0.17986591f, -0.10738580f, -0.06376371f, -0.026595421f, +0.00842492f, +0.04272362f, +0.08608052f, +0.15240218f,
    -0.10953678f, -0.057022586f, -0.012483291f, +0.024463262f, +0.06076792f, +0.09776234f, +0.12983681f, +0.18648379f,
    -0.16471463f, -0.089491285f, -0.037574016f, +0.004444791f, +0.039293647f, +0.07845859f, +0.12893885f, +0.23508036f,
};

/* ---------- FWHT rotation (matches CUDA turbo_rotate_forward_cuda) ---------- */

static void fwht_128(float * x) {
    for (int h = 1; h < 128; h *= 2) {
        for (int i = 0; i < 128; i += h * 2) {
            for (int j = i; j < i + h; j++) {
                float a = x[j], b = x[j + h];
                x[j]     = a + b;
                x[j + h] = a - b;
            }
        }
    }
    const float inv_sqrt_128 = 0.08838834764831845f;
    for (int i = 0; i < 128; i++) x[i] *= inv_sqrt_128;
}

void eliza_turbo_rotate_forward(float x[128]) {
    for (int i = 0; i < 128; i++) x[i] *= ELIZA_TURBO_WHT_SIGNS1[i];
    fwht_128(x);
    for (int i = 0; i < 128; i++) x[i] *= ELIZA_TURBO_WHT_SIGNS2[i];
}

/* ---------- nearest centroid helpers ---------- */

static uint8_t nearest_3bit(float v) {
    if      (v < ELIZA_TURBO_MID_3BIT[0]) return 0;
    else if (v < ELIZA_TURBO_MID_3BIT[1]) return 1;
    else if (v < ELIZA_TURBO_MID_3BIT[2]) return 2;
    else if (v < ELIZA_TURBO_MID_3BIT[3]) return 3;
    else if (v < ELIZA_TURBO_MID_3BIT[4]) return 4;
    else if (v < ELIZA_TURBO_MID_3BIT[5]) return 5;
    else if (v < ELIZA_TURBO_MID_3BIT[6]) return 6;
    return 7;
}

static uint8_t nearest_4bit(float v) {
    for (uint8_t i = 0; i < 15; i++) {
        if (v < ELIZA_TURBO_MID_4BIT[i]) return i;
    }
    return 15;
}

/* ---------- TURBO3: 4 blocks form one 128-element rotation group ---------- */

void eliza_quantize_turbo3_group(const float src[128], eliza_block_turbo3_0 dst[4]) {
    float x[128];
    float norm_sq = 0.0f;
    for (int j = 0; j < 128; j++) { x[j] = src[j]; norm_sq += x[j] * x[j]; }
    float grp_norm = sqrtf(norm_sq);
    float inv_norm = grp_norm > 1e-10f ? 1.0f / grp_norm : 0.0f;
    for (int j = 0; j < 128; j++) x[j] *= inv_norm;
    eliza_turbo_rotate_forward(x);

    float recon_norm_sq = 0.0f;
    for (int b = 0; b < 4; b++) {
        memset(dst[b].qs, 0, sizeof(dst[b].qs));
        memset(dst[b].signs, 0, sizeof(dst[b].signs));
        for (int j = 0; j < ELIZA_QK_TURBO3; j++) {
            uint8_t idx = nearest_3bit(x[b * ELIZA_QK_TURBO3 + j]);
            dst[b].qs[j / 4] |= (uint8_t)((idx & 0x3) << ((j % 4) * 2));
            if (idx & 0x4) dst[b].signs[j / 8] |= (uint8_t)(1 << (j % 8));
            float c = ELIZA_TURBO_CENTROIDS_3BIT[idx];
            recon_norm_sq += c * c;
        }
    }
    float recon_norm = sqrtf(recon_norm_sq);
    float corrected = (recon_norm > 1e-10f) ? grp_norm / recon_norm : grp_norm;
    uint16_t h = eliza_fp32_to_fp16(corrected);
    for (int b = 0; b < 4; b++) dst[b].norm = h;
}

void eliza_dequantize_turbo3_group(const eliza_block_turbo3_0 src[4], float dst[128]) {
    /* Per-block layout: index = (qs[j/4] >> ((j%4)*2)) & 0x3) | (signs[j/8] >> (j%8)) << 2 */
    /* Result is the rotated representation scaled by per-block norm. The full
     * inverse rotation is the caller's responsibility — flash-attention paths
     * pre-rotate Q so that Q · dequant(K) equals (rotated_Q) · centroids. */
    for (int b = 0; b < 4; b++) {
        float n = eliza_fp16_to_fp32(src[b].norm);
        for (int j = 0; j < ELIZA_QK_TURBO3; j++) {
            uint8_t low2 = (uint8_t)((src[b].qs[j / 4] >> ((j % 4) * 2)) & 0x3);
            uint8_t hi1  = (uint8_t)((src[b].signs[j / 8] >> (j % 8)) & 0x1);
            uint8_t idx  = (uint8_t)(low2 | (hi1 << 2));
            dst[b * ELIZA_QK_TURBO3 + j] = ELIZA_TURBO_CENTROIDS_3BIT[idx] * n;
        }
    }
}

/* ---------- TURBO4: one 128-element block ---------- */

void eliza_quantize_turbo4_block(const float src[128], eliza_block_turbo4_0 * dst) {
    float norm_sq = 0.0f;
    for (int j = 0; j < 128; j++) norm_sq += src[j] * src[j];
    float norm = sqrtf(norm_sq);
    float inv_norm = norm > 1e-10f ? 1.0f / norm : 0.0f;
    float x[128];
    for (int j = 0; j < 128; j++) x[j] = src[j] * inv_norm;
    eliza_turbo_rotate_forward(x);

    for (int j = 0; j < 128; j += 2) {
        uint8_t i0 = nearest_4bit(x[j]);
        uint8_t i1 = nearest_4bit(x[j + 1]);
        dst->qs[j / 2] = (uint8_t)((i1 << 4) | (i0 & 0xF));
    }

    float recon_sq = 0.0f;
    for (int j = 0; j < 128; j++) {
        uint8_t idx = (j & 1) ? (uint8_t)(dst->qs[j / 2] >> 4)
                              : (uint8_t)(dst->qs[j / 2] & 0xF);
        float r = ELIZA_TURBO_CENTROIDS_4BIT[idx];
        recon_sq += r * r;
    }
    float recon_norm = sqrtf(recon_sq);
    float corrected = (recon_norm > 1e-10f) ? norm / recon_norm : norm;
    dst->norm = eliza_fp32_to_fp16(corrected);
}

void eliza_dequantize_turbo4_block(const eliza_block_turbo4_0 * src, float dst[128]) {
    float n = eliza_fp16_to_fp32(src->norm);
    for (int j = 0; j < 128; j++) {
        uint8_t idx = (j & 1) ? (uint8_t)(src->qs[j / 2] >> 4)
                              : (uint8_t)(src->qs[j / 2] & 0xF);
        dst[j] = ELIZA_TURBO_CENTROIDS_4BIT[idx] * n;
    }
}

/* ---------- TURBO3_TCQ ---------- */

/* Right-shift trellis: state' = ((state & 0x3F) << 3) | out, where out is the
 * 3-bit symbol. So the predecessor of state' is ((state' & 0x1FF) >> 3) plus
 * any of 8 high bits — we scan all 8 prevs of state' & 0x3F. */
void eliza_quantize_turbo3_tcq_block(const float src[128], eliza_block_turbo3_tcq * dst) {
    float x[128];
    float norm_sq = 0.0f;
    for (int j = 0; j < 128; j++) { x[j] = src[j]; norm_sq += x[j] * x[j]; }
    float grp_norm = sqrtf(norm_sq);
    float inv_norm = grp_norm > 1e-10f ? 1.0f / grp_norm : 0.0f;
    for (int j = 0; j < 128; j++) x[j] *= inv_norm;
    eliza_turbo_rotate_forward(x);

    /* Viterbi forward pass: 512-state trellis. Start cost 0 for all states
     * (free initial state, matching the CUDA kernel). */
    static float cost_a[512];
    static float cost_b[512];
    static uint8_t bt[128 * 64]; /* predecessor-low byte per low-state per step */
    for (int s = 0; s < 512; s++) cost_a[s] = 0.0f;
    float * cur = cost_a;
    float * nxt = cost_b;

    for (int t = 0; t < 128; t++) {
        /* For each low-6-bit group, find best of 8 prevs. */
        float pred_min[64];
        for (int low = 0; low < 64; low++) {
            int base_prev = low << 3;
            float best = cur[base_prev];
            int best_p = 0;
            for (int p = 1; p < 8; p++) {
                float c = cur[base_prev | p];
                if (c < best) { best = c; best_p = p; }
            }
            pred_min[low] = best;
            bt[t * 64 + low] = (uint8_t)best_p;
        }
        for (int s = 0; s < 512; s++) {
            int pred_idx = s & 0x3F;
            float dist = x[t] - ELIZA_TURBO3_TCQ_CODEBOOK[s];
            nxt[s] = pred_min[pred_idx] + dist * dist;
        }
        float * tmp = cur; cur = nxt; nxt = tmp;
    }

    /* Best final state. */
    int final_state = 0;
    float best_cost = cur[0];
    for (int s = 1; s < 512; s++) {
        if (cur[s] < best_cost) { best_cost = cur[s]; final_state = s; }
    }

    /* Backtrack to recover outputs[] and the initial state. */
    uint8_t outputs[128];
    int state = final_state;
    for (int t = 127; t >= 0; t--) {
        outputs[t] = (uint8_t)((state >> 6) & 0x7);
        int p = bt[t * 64 + (state & 0x3F)];
        state = ((state & 0x3F) << 3) | p;
    }
    int initial_state = state;

    /* Recon norm. */
    float recon_sq = 0.0f;
    for (int t = 0; t < 128; t++) {
        int s;
        if (t < 2) {
            s = initial_state;
            for (int k = 0; k <= t; k++) {
                s = (s >> 3) | (((int)outputs[k]) << 6);
            }
        } else {
            s = ((int)outputs[t - 2] & 0x7)
              | (((int)outputs[t - 1] & 0x7) << 3)
              | (((int)outputs[t]     & 0x7) << 6);
        }
        float c = ELIZA_TURBO3_TCQ_CODEBOOK[s];
        recon_sq += c * c;
    }
    float recon_norm = sqrtf(recon_sq);
    float corrected = (recon_norm > 1e-10f) ? grp_norm / recon_norm : grp_norm;
    dst->norm = eliza_fp32_to_fp16(corrected);

    /* Bitpack: 6 bits of (initial_state >> 3), then 128 * 3-bit symbols. */
    memset(dst->qs, 0, sizeof(dst->qs));
    int init_bits = (initial_state >> 3) & 0x3F;
    for (int byte = 0; byte < 49; byte++) {
        uint8_t packed = 0;
        for (int bit = 0; bit < 8; bit++) {
            int pos = byte * 8 + bit;
            int v = 0;
            if (pos < 6) {
                v = (init_bits >> pos) & 1;
            } else {
                int sym_bit = pos - 6;
                int sym_idx = sym_bit / 3;
                if (sym_idx < 128) v = (outputs[sym_idx] >> (sym_bit % 3)) & 1;
            }
            packed |= (uint8_t)(v << bit);
        }
        dst->qs[byte] = packed;
    }
    dst->pad = 0;
}

void eliza_dequantize_turbo3_tcq_block(const eliza_block_turbo3_tcq * src, float dst[128]) {
    float n = eliza_fp16_to_fp32(src->norm);
    for (int t = 0; t < 128; t++) {
        int bit_pos = t * 3;
        int byte_idx = bit_pos / 8;
        int bit_off = bit_pos % 8;
        uint16_t raw = (uint16_t)src->qs[byte_idx];
        if (byte_idx + 1 < 49) raw |= (uint16_t)src->qs[byte_idx + 1] << 8;
        int state = (raw >> bit_off) & 0x1FF;
        dst[t] = ELIZA_TURBO3_TCQ_CODEBOOK[state] * n;
    }
}

/* ---------- dot products (used for verification) ---------- */

float eliza_dot_q_turbo3(const float q[128], const eliza_block_turbo3_0 k[4]) {
    float k_full[128];
    eliza_dequantize_turbo3_group(k, k_full);
    double s = 0.0;
    for (int i = 0; i < 128; i++) s += (double)q[i] * (double)k_full[i];
    return (float)s;
}

float eliza_dot_q_turbo4(const float q[128], const eliza_block_turbo4_0 * k) {
    float k_full[128];
    eliza_dequantize_turbo4_block(k, k_full);
    double s = 0.0;
    for (int i = 0; i < 128; i++) s += (double)q[i] * (double)k_full[i];
    return (float)s;
}

float eliza_dot_q_turbo3_tcq(const float q[128], const eliza_block_turbo3_tcq * k) {
    float k_full[128];
    eliza_dequantize_turbo3_tcq_block(k, k_full);
    double s = 0.0;
    for (int i = 0; i < 128; i++) s += (double)q[i] * (double)k_full[i];
    return (float)s;
}
