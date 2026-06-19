#include <cuda_fp16.h>
#include <stdio.h>
#include <torch/extension.h>
#include <math_constants.h>
#include <cmath>

#define VECTORIZE_FACTOR 8
#define Q_VECTORIZE_FACTOR 8
#define PACK_FACTOR 8
#define WARP_SIZE 32
#define PACK_SIZE 16

template <typename T>
__device__ float convert_to_float(T value) {
    // Return 0 by default, indicating misuse if not specialized correctly.
    return 0.0f;
}

template <>
__device__ float convert_to_float<c10::Half>(c10::Half value) {
    return __half2float(value);
}

template <>
__device__ float convert_to_float<float>(float value) {
    return value;
}

template <>
__device__ float convert_to_float<at::BFloat16>(at::BFloat16 value) {
    return static_cast<float>(value);
}

template <typename T>
__device__ T convert_from_float(float value) {
    // Return 0 by default, indicating misuse if not specialized correctly.
    return static_cast<T>(0);
}

template <>
__device__ c10::Half convert_from_float<c10::Half>(float value) {
    return __float2half(value);
}

template <>
__device__ float convert_from_float<float>(float value) {
    return value;
}

template <>
__device__ at::BFloat16 convert_from_float<at::BFloat16>(float value) {
    return static_cast<at::BFloat16>(value);
}

__device__ __forceinline__ float warp_reduce_sum(float sum) {
  #pragma unroll
  for(int i = 4; i >= 0; i--){
    sum += __shfl_down_sync(0xffffffff, sum, 1<<i);
  }
  return sum;
}

__device__ __forceinline__ int make_divisible(int c, int divisor){
  return (c + divisor - 1) / divisor;
}

template <typename T>
__global__ void batchedQuantizedMultiplyAccumulate(
  T* _inputs, const uint32_t* _weight, T* _zeros, T* _scale, T* _outputs,
  const int IC, const int OC, const int group_size, const int nh, const bool mqa, const int bit){
    const int pack_factor = 32 / bit;
    const int batch_idx = blockIdx.x;
    const int packed_oc_idx = blockIdx.y * blockDim.y + threadIdx.y; 
    const int oc_start_idx = packed_oc_idx * pack_factor;
    const int group_idx = oc_start_idx / group_size; 
    T* inputs = _inputs + batch_idx * IC;
    T* outputs = _outputs + batch_idx * OC;
    int _batch_idx;
    if (mqa){
      _batch_idx = batch_idx / nh;
    }else{
      _batch_idx = batch_idx;
    }
    const uint32_t*  weight = _weight + _batch_idx * OC * IC / pack_factor;
    T* scaling_factors = _scale + _batch_idx * OC * IC / group_size;
    T* zeros = _zeros + _batch_idx * OC * IC / group_size;
    const int TILE_DIM = 128;
    const int num = 0xFF >> (8-bit);
    float psum[PACK_SIZE]{};
    for (int k=0; k < (IC + TILE_DIM - 1) / TILE_DIM; k++){
      uint32_t qw[4]{};
      T cscale[4]{};
      T czero[4]{};
      T inp[4]{};
      int weight_offset = packed_oc_idx * IC + k * TILE_DIM + threadIdx.x*4;
      int scale_mn_offset = group_idx * IC + k * TILE_DIM + threadIdx.x*4;
      int inputs_ptr_delta = k * TILE_DIM + threadIdx.x * 4; 
      for (int i=0; i<4; i++){
        if (weight_offset + i < OC * IC / pack_factor)
          qw[i] = *(weight + weight_offset + i);
        if (scale_mn_offset + i < OC * IC / group_size){
          cscale[i] = *(scaling_factors + scale_mn_offset + i);
          czero[i] = *(zeros + scale_mn_offset + i);}
        if (inputs_ptr_delta + i < IC)
          inp[i] = *(inputs + inputs_ptr_delta + i);
      }
      #pragma unroll
      for (int ic_0 = 0; ic_0 < 4; ic_0++){
        uint32_t cur_packed_weight =  qw[ic_0];
        float cur_inp = convert_to_float<T>(inp[ic_0]);
        float cur_scale = convert_to_float<T>(cscale[ic_0]);
        float cur_zero = convert_to_float<T>(czero[ic_0]);
        for (int ic_1 = 0; ic_1 < pack_factor; ic_1++){
          int oc_idx = oc_start_idx + ic_1;
          if (oc_idx < OC){
            float cur_single_weight_fp = (float)(cur_packed_weight & num);
            float dequantized_weight = cur_scale * cur_single_weight_fp + cur_zero;
            cur_packed_weight = cur_packed_weight >> bit;
            psum[ic_1] += dequantized_weight * cur_inp;
          }
        }
      }
    }
    for (int i=0; i < pack_factor; i++){
      int oc_idx = oc_start_idx + i;
      if (oc_idx < OC){
        psum[i] = warp_reduce_sum(psum[i]);
        if (threadIdx.x == 0) 
          outputs[oc_idx] = convert_from_float<T>(psum[i]);
      }
    }
}

template <typename T>
torch::Tensor batchedQuantizedMultiplyAccumulateTemplate(
    torch::Tensor _in_feats,
    torch::Tensor _kernel,
    torch::Tensor _scaling_factors,
    torch::Tensor _zeros,
    const int bit,
    const int group_size,
    const int nh,
    const bool mqa)
{
    int BS = _in_feats.size(0);
    int num_in_feats = _in_feats.size(1);
    int num_in_channels = _in_feats.size(2);
    int num_out_channels = _zeros.size(1) * group_size;

    auto in_feats = _in_feats.data_ptr<T>();
    auto kernel = reinterpret_cast<uint32_t*>(_kernel.data_ptr<int>());
    auto zeros = _zeros.data_ptr<T>();
    auto scaling_factors = _scaling_factors.data_ptr<T>();

    auto options =
    torch::TensorOptions().dtype(_in_feats.dtype()).device(_in_feats.device());

    at::Tensor _out_feats = torch::empty({BS, num_in_feats, num_out_channels}, options);
    int num_out_feats = _out_feats.size(-2);
    auto out_feats = _out_feats.data_ptr<T>();
    int pack_factor = 32 / bit;
    dim3 num_blocks(BS, (num_out_channels / pack_factor + 3) / 4, num_out_feats);
    dim3 num_threads(32, 4);
    batchedQuantizedMultiplyAccumulate<<<num_blocks, num_threads>>>(
        in_feats, kernel, zeros, scaling_factors, out_feats,
        num_in_channels, num_out_channels, group_size, nh, mqa, bit
      );     
    return _out_feats;
}

PYBIND11_MODULE(TORCH_EXTENSION_NAME, m)
{
    m.def("batchedQuantizedMultiplyAccumulate_half", &batchedQuantizedMultiplyAccumulateTemplate<c10::Half>);
    m.def("batchedQuantizedMultiplyAccumulate_float", &batchedQuantizedMultiplyAccumulateTemplate<float>);
    m.def("batchedQuantizedMultiplyAccumulate_bf16", &batchedQuantizedMultiplyAccumulateTemplate<at::BFloat16>);
}