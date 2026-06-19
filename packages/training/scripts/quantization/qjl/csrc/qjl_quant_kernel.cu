#include <torch/extension.h>
#include <math_constants.h>
#include <cmath>

#define WARP_SIZE 32
#define WARPS_PER_BLOCK 32
// EMB_DIM is a compile-time template parameter on the kernel and the
// host wrapper below. Upstream hard-coded EMB_DIM=128. Active Qwen3.5
// text models use head_dim=256, so we instantiate {128, 256}.

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
    T* key_states,
    uint8_t* key_quant,
    uint8_t* key_outlier_quant,
    const uint8_t* outlier_indices,
    const Tproj* rand_prj,
    T* outlier_norms,
    int batch_size, int head_size, int n_size, int group_size, int sketch_dim, int outlier_sketch_dim, int emb_dim,
    int outlier_counts) {

    size_t bhn = blockIdx.x;
    size_t threadLane = threadIdx.x;
    size_t wIdx = threadIdx.y;
    size_t gIdx = blockIdx.y * WARP_SIZE;
    size_t pIdx = blockIdx.z * WARPS_PER_BLOCK + wIdx;

    int hash_dim = sketch_dim/8;
    int outlier_hash_dim = outlier_sketch_dim/8;

    int base_index_key_quant = (bhn * group_size * hash_dim) + ((gIdx+threadLane) * hash_dim);
    int base_index_outlier_quant = (bhn * group_size * outlier_hash_dim) + ((gIdx+threadLane) * outlier_hash_dim);

    int base_index_outlier_indices = bhn * outlier_counts;
    const uint8_t* outlier_ind = outlier_indices + base_index_outlier_indices;

    int base_index_key = (bhn * group_size * emb_dim) + (gIdx * emb_dim);
    T* key = key_states + base_index_key;

    int base_index_rand_prj = (pIdx * emb_dim);
    const Tproj* sketch = rand_prj + base_index_rand_prj;

    int base_index_outlier_norm = (bhn * group_size) + gIdx;
    T* key_outlier_norm = outlier_norms + base_index_outlier_norm;

    __shared__ uint8_t shared_mask[EMB_DIM];
    size_t tIdx = wIdx * WARP_SIZE + threadLane;
#pragma unroll
    for (size_t tile_idx{tIdx}; tile_idx < EMB_DIM; tile_idx += (WARP_SIZE * WARPS_PER_BLOCK)) {
        shared_mask[tile_idx] = 0;
    }
    __syncthreads();
    if (tIdx < outlier_counts){
        size_t otlr_idx = outlier_ind[tIdx];
        shared_mask[otlr_idx] = 1;
    }
    __syncthreads();

    __shared__ float shared_keys[EMB_DIM][WARP_SIZE];
#pragma unroll
    for (size_t grp_tile{wIdx}; grp_tile < WARP_SIZE; grp_tile += WARPS_PER_BLOCK) {
#pragma unroll
        for (size_t chnl_tile{threadLane}; chnl_tile < EMB_DIM; chnl_tile += WARP_SIZE){
            shared_keys[chnl_tile][grp_tile] = convert_to_float<T>(key[grp_tile*EMB_DIM + chnl_tile]);
        }
    }
    __syncthreads();

    float sketched_keys = 0.0;
    float sketched_outliers = 0.0;
#pragma unroll
    for (size_t chnl_idx{0}; chnl_idx < EMB_DIM; chnl_idx++){
        float key_proj_prod = convert_to_float<Tproj>(sketch[chnl_idx]) * shared_keys[chnl_idx][threadLane];
        if (shared_mask[chnl_idx] == 0){
            sketched_keys += key_proj_prod;
        }
        else{
            sketched_outliers += key_proj_prod;
        }
    }

    __shared__ float shared_outlier_norms[WARP_SIZE];
    if (blockIdx.z == 0) {
        if (wIdx == 0){
            shared_outlier_norms[threadLane] = 0.0;
        }
        __syncthreads();

#pragma unroll
        for (size_t chnl_idx{wIdx}; chnl_idx < EMB_DIM; chnl_idx += WARPS_PER_BLOCK) {
            if (shared_mask[chnl_idx] != 0) {
                atomicAdd(&shared_outlier_norms[threadLane], pow(shared_keys[chnl_idx][threadLane], 2));
            }
        }
    }
    __syncthreads();

    __shared__ uint8_t shared_key_quant[WARP_SIZE][WARPS_PER_BLOCK];
    __shared__ uint8_t shared_key_outlier_quant[WARP_SIZE][WARPS_PER_BLOCK];
    shared_key_quant[threadLane][wIdx] = (sketched_keys>0 ? (1<<(wIdx%8)) :0);
    shared_key_outlier_quant[threadLane][wIdx] = (sketched_outliers>0 ? (1<<(wIdx%8)) :0);
    __syncthreads();

    if (gIdx+threadLane >= group_size) return;

    if ((wIdx%8) == 0) {
        uint8_t hashed_key = 0;
#pragma unroll
        for (int shift = 0; shift < 8; shift ++){
            hashed_key += shared_key_quant[threadLane][wIdx+shift];
        }
        key_quant[base_index_key_quant+pIdx/8] = hashed_key;

        if (pIdx >= outlier_sketch_dim) return;

        uint8_t hashed_outlier = 0;
#pragma unroll
        for (int shift = 0; shift < 8; shift ++){
            hashed_outlier += shared_key_outlier_quant[threadLane][wIdx+shift];
        }
        key_outlier_quant[base_index_outlier_quant+pIdx/8] = hashed_outlier;
    } else if ((wIdx == 1) && (blockIdx.z == 0)){
        key_outlier_norm[threadLane] = convert_from_float<T>(sqrtf(shared_outlier_norms[threadLane]));
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
std::tuple<torch::Tensor, torch::Tensor, torch::Tensor> QJLQuantCudaTemplate(
    torch::Tensor key_states,
    torch::Tensor outlier_indices,
    torch::Tensor rand_prj,
    int outlier_sketch_dim) {

    auto options = torch::TensorOptions().device(torch::kCUDA, 0).dtype(torch::kUInt8);
    auto options_outlier_norm = getOptionsForType(typeid(T));

    int batch = key_states.size(0);
    int head = key_states.size(1);
    int n = key_states.size(2);
    int group_size = key_states.size(3);
    int emb_dim = key_states.size(4);
    int sketch_dim = rand_prj.size(0);
    int hash_dim = sketch_dim/8;
    int outlier_hash_dim = outlier_sketch_dim/8;
    int outlier_counts = outlier_indices.size(3);

    TORCH_CHECK(emb_dim == EMB_DIM,
        "QJL quant kernel: runtime emb_dim (", emb_dim,
        ") does not match compiled EMB_DIM (", EMB_DIM,
        "). The Python wrapper must dispatch to the right specialization.");

    auto key_quant = torch::zeros({batch, head, n, group_size, hash_dim}, options).contiguous();
    auto key_outlier_quant = torch::zeros({batch, head, n, group_size, outlier_hash_dim}, options).contiguous();
    auto outlier_norms = torch::zeros({batch, head, n, group_size}, options_outlier_norm).contiguous();

    int blocksPerGroup = (group_size + WARP_SIZE - 1) / WARP_SIZE;
    int numProjBlocks = sketch_dim / WARPS_PER_BLOCK;
    dim3 numBlocks(batch * head * n, blocksPerGroup, numProjBlocks);
    dim3 threadsPerBlockDim(WARP_SIZE, WARPS_PER_BLOCK, 1);

    auto key_states_ptr = key_states.data_ptr<T>();
    auto outlier_norms_ptr = outlier_norms.data_ptr<T>();
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

    quantize_with_outliers_kernel<T, Tproj, EMB_DIM><<<numBlocks, threadsPerBlockDim, 0, stream>>>(
    key_states_ptr,
    key_quant.data_ptr<uint8_t>(),
    key_outlier_quant.data_ptr<uint8_t>(),
    outlier_indices.data_ptr<uint8_t>(),
    rand_prj_ptr,
    outlier_norms_ptr,
    batch, head, n, group_size, sketch_dim, outlier_sketch_dim, emb_dim, outlier_counts);

    stream_attribute.accessPolicyWindow.num_bytes = 0;                                          // Setting the window size to 0 disable it
    cudaStreamSetAttribute(stream, cudaStreamAttributeAccessPolicyWindow, &stream_attribute);   // Overwrite the access policy attribute to a CUDA Stream
    cudaCtxResetPersistingL2Cache();                                                            // Remove any persistent lines in L2

    return std::make_tuple(key_quant, key_outlier_quant, outlier_norms);
}

PYBIND11_MODULE(TORCH_EXTENSION_NAME, m) {
    // EMB_DIM=128 (Llama/Qwen3 sub-9B, Qwen2/2.5)
    m.def("qjl_quant_half_half_h128", &QJLQuantCudaTemplate<c10::Half, c10::Half, 128>, "Quantize using Half precision (head_dim=128)",
    py::arg("key_states"),
    py::arg("outlier_indices"),
    py::arg("rand_prj"),
    py::arg("outlier_sketch_dim"));

    m.def("qjl_quant_half_float_h128", &QJLQuantCudaTemplate<c10::Half, float, 128>, "Quantize using Half to Float precision (head_dim=128)",
    py::arg("key_states"),
    py::arg("outlier_indices"),
    py::arg("rand_prj"),
    py::arg("outlier_sketch_dim"));

    m.def("qjl_quant_float_float_h128", &QJLQuantCudaTemplate<float, float, 128>, "Quantize using Float precision (head_dim=128)",
    py::arg("key_states"),
    py::arg("outlier_indices"),
    py::arg("rand_prj"),
    py::arg("outlier_sketch_dim"));

    m.def("qjl_quant_bf16_bf16_h128", &QJLQuantCudaTemplate<at::BFloat16, at::BFloat16, 128>, "Quantize using BF16 precision (head_dim=128)",
    py::arg("key_states"),
    py::arg("outlier_indices"),
    py::arg("rand_prj"),
    py::arg("outlier_sketch_dim"));

    m.def("qjl_quant_bf16_float_h128", &QJLQuantCudaTemplate<at::BFloat16, float, 128>, "Quantize using BF16 to Float precision (head_dim=128)",
    py::arg("key_states"),
    py::arg("outlier_indices"),
    py::arg("rand_prj"),
    py::arg("outlier_sketch_dim"));

    // EMB_DIM=256 (active Qwen3.5 text head_dim=256)
    m.def("qjl_quant_half_half_h256", &QJLQuantCudaTemplate<c10::Half, c10::Half, 256>, "Quantize using Half precision (head_dim=256)",
    py::arg("key_states"),
    py::arg("outlier_indices"),
    py::arg("rand_prj"),
    py::arg("outlier_sketch_dim"));

    m.def("qjl_quant_half_float_h256", &QJLQuantCudaTemplate<c10::Half, float, 256>, "Quantize using Half to Float precision (head_dim=256)",
    py::arg("key_states"),
    py::arg("outlier_indices"),
    py::arg("rand_prj"),
    py::arg("outlier_sketch_dim"));

    m.def("qjl_quant_float_float_h256", &QJLQuantCudaTemplate<float, float, 256>, "Quantize using Float precision (head_dim=256)",
    py::arg("key_states"),
    py::arg("outlier_indices"),
    py::arg("rand_prj"),
    py::arg("outlier_sketch_dim"));

    m.def("qjl_quant_bf16_bf16_h256", &QJLQuantCudaTemplate<at::BFloat16, at::BFloat16, 256>, "Quantize using BF16 precision (head_dim=256)",
    py::arg("key_states"),
    py::arg("outlier_indices"),
    py::arg("rand_prj"),
    py::arg("outlier_sketch_dim"));

    m.def("qjl_quant_bf16_float_h256", &QJLQuantCudaTemplate<at::BFloat16, float, 256>, "Quantize using BF16 to Float precision (head_dim=256)",
    py::arg("key_states"),
    py::arg("outlier_indices"),
    py::arg("rand_prj"),
    py::arg("outlier_sketch_dim"));
}
