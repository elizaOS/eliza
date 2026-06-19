#include <torch/extension.h>
#include <math_constants.h>
#include <cmath>

#define WARP_SIZE 32
#define WARPS_PER_BLOCK 32
// EMB_DIM is a compile-time template parameter on the kernel and host
// wrapper. Upstream hard-coded EMB_DIM=128. We instantiate {128, 256}
// to support active Qwen3.5 text models (head_dim=256).
//
// NOTE: this file has multiple upstream bugs (typos like `sketched_vaues`,
// undefined `quantize_value_kernel` symbol, returning wrong tensors) and
// is NOT compiled by setup.py. Templating is preserved for source-level
// consistency only — fixing the upstream bugs is out of scope.

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



template<typename T, typename Tproj, int EMB_DIM>
__global__ void quantize_with_outliers_kernel(
    T* value_states,
    uint8_t* value_quant,
    const Tproj* rand_prj,
    int batch_size, int head_size, int n_size, int sketch_dim, int emb_dim) {

    size_t bh = blockIdx.x;
    size_t threadLane = threadIdx.x;
    size_t wIdx = threadIdx.y;
    size_t nIdx = blockIdx.y * WARP_SIZE;
    size_t pIdx = blockIdx.z * WARPS_PER_BLOCK + wIdx;

    int hash_dim = sketch_dim/8;

    int base_index_value_quant = (bh * n_size * hash_dim) + ((nIdx+threadLane) * hash_dim);

    int base_index_value = (bh * n_size * emb_dim) + (nIdx * emb_dim);
    T* value = value_states + base_index_value;

    int base_index_rand_prj = (pIdx * emb_dim);
    const Tproj* sketch = rand_prj + base_index_rand_prj;

    __shared__ float shared_values[EMB_DIM][WARP_SIZE];
#pragma unroll
    for (size_t grp_tile{wIdx}; grp_tile < WARP_SIZE; grp_tile += WARPS_PER_BLOCK) {
#pragma unroll
        for (size_t chnl_tile{threadLane}; chnl_tile < EMB_DIM; chnl_tile += WARP_SIZE){
            shared_values[chnl_tile][grp_tile] = convert_to_float<T>(value[grp_tile*EMB_DIM + chnl_tile]);
        }
    }
    __syncthreads();

    float sketched_values = 0.0;
#pragma unroll
    for (size_t chnl_idx{0}; chnl_idx < EMB_DIM; chnl_idx++){
        sketched_vaues += convert_to_float<Tproj>(sketch[chnl_idx]) * shared_values[chnl_idx][threadLane];
    }
    __syncthreads();

    __shared__ uint8_t shared_value_quant[WARP_SIZE][WARPS_PER_BLOCK];
    shared_value_quant[threadLane][wIdx] = (sketched_values>0 ? (1<<(wIdx%8)) :0);
    __syncthreads();

    if (nIdx+threadLane >= n_size) return;

    if ((wIdx%8) == 0) {
        uint8_t hashed_value = 0;
#pragma unroll
        for (int shift = 0; shift < 8; shift ++){
            hashed_value += shared_value_quant[threadLane][wIdx+shift];
        }
        value_quant[base_index_value_quant+pIdx/8] = hashed_value;
    }
    return;
}


torch::TensorOptions getOptionsForType(const std::type_info& typeInfo) {
    if (typeInfo == typeid(c10::Half)) {
        return torch::TensorOptions().device(torch::kCUDA, 0).dtype(torch::kHalf);
    } else if (typeInfo == typeid(float)) {
        return torch::TensorOptions().device(torch::kCUDA, 0).dtype(torch::kFloat);
    } else if (typeInfo == typeid(at::BFloat16)) {
        return torch::TensorOptions().device(torch::kCUDA, 0).dtype(torch::kBFloat16);
    } else {
        // Default case for unexpected types
        throw std::runtime_error("Unsupported type for tensor options.");
    }
}

template <typename T, typename Tproj, int EMB_DIM>
std::tuple<torch::Tensor, torch::Tensor, torch::Tensor> QJLQuantValCudaTemplate(
    torch::Tensor value_states,
    torch::Tensor rand_prj) {

    auto options = torch::TensorOptions().device(torch::kCUDA, 0).dtype(torch::kUInt8);

    int batch = value_states.size(0);
    int head = value_states.size(1);
    int n = value_states.size(2);
    int emb_dim = value_states.size(4);
    int sketch_dim = rand_prj.size(0);
    int hash_dim = sketch_dim/8;

    auto value_quant = torch::zeros({batch, head, n, hash_dim}, options).contiguous();

    int blocksPerSeq = (n + WARP_SIZE - 1) / WARP_SIZE;
    int numProjBlocks = sketch_dim / WARPS_PER_BLOCK;
    dim3 numBlocks(batch * head, blocksPerSeq, numProjBlocks);
    dim3 threadsPerBlockDim(WARP_SIZE, WARPS_PER_BLOCK, 1);

    auto value_states_ptr = value_states.data_ptr<T>();
    auto rand_prj_ptr = rand_prj.data_ptr<Tproj>();


//     Compiler hints for using L2 Persistent Cache
    cudaStream_t stream;
    cudaStreamCreate(&stream);                                                                  // Create CUDA stream
    int device_id{0};
    cudaGetDevice(&device_id);                                                                  // Device ID

    cudaDeviceProp prop;                                                                        // CUDA device properties variable
    cudaGetDeviceProperties( &prop, device_id);                                                 // Query GPU properties
    size_t size = min( 1024 * 1024 , prop.persistingL2CacheMaxSize );
    cudaDeviceSetLimit( cudaLimitPersistingL2CacheSize, size);                                  // set-aside 1 Mbytes of L2 cache for persisting accesses or the max allowed

    size_t num_bytes = sketch_dim * emb_dim * sizeof(T);
    size_t window_size = min(static_cast<size_t>(prop.accessPolicyMaxWindowSize), num_bytes);   // Select minimum of user defined num_bytes and max window size.

    cudaStreamAttrValue stream_attribute;                                                       // Stream level attributes data structure
    stream_attribute.accessPolicyWindow.base_ptr  = reinterpret_cast<void*>(rand_prj_ptr);      // Global Memory data pointer
    stream_attribute.accessPolicyWindow.num_bytes = window_size;                                // Number of bytes for persistence access
    stream_attribute.accessPolicyWindow.hitRatio  = 1.0;                                        // Hint for cache hit ratio
    stream_attribute.accessPolicyWindow.hitProp   = cudaAccessPropertyPersisting;               // Persistence Property
    stream_attribute.accessPolicyWindow.missProp  = cudaAccessPropertyStreaming;                // Type of access property on cache miss

    cudaStreamSetAttribute(stream, cudaStreamAttributeAccessPolicyWindow, &stream_attribute);   // Set the attributes to a CUDA Stream

    quantize_value_kernel<<<numBlocks, threadsPerBlockDim, 0, stream>>>(
    value_states_ptr,
    value_quant.data_ptr<uint8_t>(),
    rand_prj_ptr,
    batch, head, n, sketch_dim, emb_dim);

    stream_attribute.accessPolicyWindow.num_bytes = 0;                                          // Setting the window size to 0 disable it
    cudaStreamSetAttribute(stream, cudaStreamAttributeAccessPolicyWindow, &stream_attribute);   // Overwrite the access policy attribute to a CUDA Stream
    cudaCtxResetPersistingL2Cache();                                                            // Remove any persistent lines in L2

    return std::make_tuple(key_quant, key_outlier_quant, outlier_norms);
}

PYBIND11_MODULE(TORCH_EXTENSION_NAME, m) {
    m.def("qjl_quant_value_half_half", &QJLQuantValCudaTemplate<c10::Half, c10::Half>, "Quantize using Half precision",
    py::arg("key_states"),
    py::arg("outlier_indices"),
    py::arg("rand_prj"),
    py::arg("outlier_sketch_dim"));

    m.def("qjl_quant_value_half_float", &QJLQuantValCudaTemplate<c10::Half, float>, "Quantize using Half to Float precision",
    py::arg("key_states"),
    py::arg("outlier_indices"),
    py::arg("rand_prj"),
    py::arg("outlier_sketch_dim"));

    m.def("qjl_quant_value_float_float", &QJLQuantValCudaTemplate<float, float>, "Quantize using Float precision",
    py::arg("key_states"),
    py::arg("outlier_indices"),
    py::arg("rand_prj"),
    py::arg("outlier_sketch_dim"));

    m.def("qjl_quant_value_bf16_bf16", &QJLQuantValCudaTemplate<at::BFloat16, at::BFloat16>, "Quantize using BF16 precision",
    py::arg("key_states"),
    py::arg("outlier_indices"),
    py::arg("rand_prj"),
    py::arg("outlier_sketch_dim"));

    m.def("qjl_quant_value_bf16_float", &QJLQuantValCudaTemplate<at::BFloat16, float>, "Quantize using BF16 to Float precision",
    py::arg("key_states"),
    py::arg("outlier_indices"),
    py::arg("rand_prj"),
    py::arg("outlier_sketch_dim"));
}
