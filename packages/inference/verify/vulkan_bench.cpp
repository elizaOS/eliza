// Host-side Vulkan **benchmark** harness for the Eliza-1 KV-score / fused-attn
// compute shaders. Sibling of vulkan_verify.cpp (correctness) — this one only
// measures GPU time per dispatch via VK_QUERY_TYPE_TIMESTAMP, and sweeps the
// runtime-tunable knobs the device-policy table needs:
//
//   * standalone score kernels (turbo3 / turbo4 / turbo3_tcq / qjl / polar /
//     polar_preht): vary n_kv (resp. n_tokens / n_rows) and, for the _multi
//     variants, the constant_id=0 spec constant BLOCKS_PER_WG / TOKENS_PER_WG
//     in {1,2,4,8,16}.
//   * fused-attn (fused_attn_qjl_tbq / fused_attn_qjl_polar): vary n_heads and
//     n_kv.
//
// It does NOT verify numbers — vulkan_verify already does that to the published
// tolerance, and a bench run uses synthetic (zeroed / small-noise) inputs so it
// can scale n_kv to 32k without giant fixture files. The timing pipeline:
//   - one warm-up submit (drives Mesa shader compile / first-use paths),
//   - then `runs` measured submits, each: reset query pool, write TS before +
//     after the dispatch, submit, wait idle, read the two 64-bit counters,
//     convert to ns via VkPhysicalDeviceLimits::timestampPeriod.
//   - report median over `runs`.
//
// Build (from packages/inference/verify):
//     make vulkan-bench           # uses the same header/lib resolution as vulkan_verify
// Run:
//     ./vulkan_bench [--json out.json] [--runs N] [--warmup W]
//
// Linux + Mesa ANV exposes timestamp queries on the compute queue
// (timestampValidBits > 0 on the universal/compute family). On MoltenVK the
// timestampPeriod is also valid; lavapipe reports 1.0 ns periods. The harness
// refuses software ICDs unless ELIZA_ALLOW_SOFTWARE_VULKAN=1, same as
// vulkan_verify.

#include <vulkan/vulkan.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace {

#define VK_CHECK(expr) do {                                                   \
    VkResult _r = (expr);                                                     \
    if (_r != VK_SUCCESS) {                                                   \
        std::fprintf(stderr, "%s failed: %d\n", #expr, (int)_r);              \
        std::exit(1);                                                         \
    }                                                                         \
} while (0)

static std::string lower_ascii(const char * s) {
    std::string out = s ? s : "";
    for (char & c : out) if (c >= 'A' && c <= 'Z') c = (char)(c - 'A' + 'a');
    return out;
}
static bool software_vulkan_allowed() {
    const char * v = std::getenv("ELIZA_ALLOW_SOFTWARE_VULKAN");
    return v && std::strcmp(v, "1") == 0;
}
static bool looks_like_software_vulkan_device(const char * name) {
    const std::string d = lower_ascii(name);
    return d.find("llvmpipe") != std::string::npos ||
           d.find("lavapipe") != std::string::npos ||
           d.find("swiftshader") != std::string::npos ||
           d.find("software rasterizer") != std::string::npos;
}

static std::vector<uint8_t> load_spirv(const char * path) {
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f) { std::fprintf(stderr, "cannot open SPIR-V %s\n", path); std::exit(1); }
    auto sz = (size_t)f.tellg();
    if (sz % 4 != 0) { std::fprintf(stderr, "%s is not 4-byte aligned\n", path); std::exit(1); }
    std::vector<uint8_t> bytes(sz);
    f.seekg(0); f.read((char *)bytes.data(), (std::streamsize)sz);
    return bytes;
}

// --- Block sizes (mirror the shader / reference layouts). ---
constexpr uint32_t HEAD_DIM        = 128;
constexpr uint32_t TURBO3_BLOCK    = 14;   // half norm + qs[8] + signs[4]
constexpr uint32_t TURBO4_BLOCK    = 18;   // half norm + qs[16]
constexpr uint32_t TURBO3_TCQ_BLOCK= 52;   // half norm + qs[49] + pad
constexpr uint32_t QJL_BLOCK       = 34;   // qs[32] + norm_bf16
constexpr uint32_t POLAR_BLOCK     = 82;   // fp16 d + qs[64] + qjl[16]
constexpr uint32_t QJL_PROJ_DIM    = 256;
constexpr uint32_t TBQ_TOKEN_BYTES = 56;   // 4 * block_tbq3_0 (14B)

struct Vk {
    VkInstance instance = VK_NULL_HANDLE;
    VkPhysicalDevice pd = VK_NULL_HANDLE;
    uint32_t qfam = (uint32_t)-1;
    VkDevice device = VK_NULL_HANDLE;
    VkQueue queue = VK_NULL_HANDLE;
    double ts_period_ns = 1.0;       // VkPhysicalDeviceLimits::timestampPeriod
    bool ts_supported = false;
    std::string device_name;
    uint32_t vendor_id = 0, device_id = 0;
    uint32_t subgroup_size = 0;
};

static Vk init_vk() {
    Vk v;
    VkApplicationInfo ai{}; ai.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
    ai.pApplicationName = "eliza-kv-bench"; ai.apiVersion = VK_API_VERSION_1_2;
    VkInstanceCreateInfo ici{}; ici.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO; ici.pApplicationInfo = &ai;
    const char * inst_exts[] = { "VK_KHR_portability_enumeration" };
    ici.enabledExtensionCount = 1; ici.ppEnabledExtensionNames = inst_exts; ici.flags = 0x00000001;
    if (vkCreateInstance(&ici, nullptr, &v.instance) != VK_SUCCESS) {
        ici.enabledExtensionCount = 0; ici.ppEnabledExtensionNames = nullptr; ici.flags = 0;
        VK_CHECK(vkCreateInstance(&ici, nullptr, &v.instance));
    }
    uint32_t pdc = 0; VK_CHECK(vkEnumeratePhysicalDevices(v.instance, &pdc, nullptr));
    if (pdc == 0) { std::fprintf(stderr, "no Vulkan devices\n"); std::exit(1); }
    std::vector<VkPhysicalDevice> pds(pdc); VK_CHECK(vkEnumeratePhysicalDevices(v.instance, &pdc, pds.data()));
    // Device selection: ELIZA_VK_DEVICE_INDEX picks the Nth enumerated device;
    // ELIZA_VK_DEVICE_SUBSTR picks the first whose deviceName contains the
    // substring (case-insensitive). Default: first compute-capable device.
    long want_index = -1;
    if (const char * e = std::getenv("ELIZA_VK_DEVICE_INDEX")) want_index = std::atol(e);
    std::string want_substr;
    if (const char * e = std::getenv("ELIZA_VK_DEVICE_SUBSTR")) {
        want_substr = e;
        for (char & c : want_substr) c = (char)std::tolower((unsigned char)c);
    }
    auto compute_qfam = [](VkPhysicalDevice cand, uint32_t & out_qfam, bool & out_ts) -> bool {
        uint32_t qc = 0; vkGetPhysicalDeviceQueueFamilyProperties(cand, &qc, nullptr);
        std::vector<VkQueueFamilyProperties> qf(qc);
        vkGetPhysicalDeviceQueueFamilyProperties(cand, &qc, qf.data());
        for (uint32_t i = 0; i < qc; i++) {
            if (qf[i].queueFlags & VK_QUEUE_COMPUTE_BIT) { out_qfam = i; out_ts = qf[i].timestampValidBits > 0; return true; }
        }
        return false;
    };
    for (uint32_t idx = 0; idx < pdc; idx++) {
        VkPhysicalDevice cand = pds[idx];
        uint32_t qfam = (uint32_t)-1; bool ts = false;
        if (!compute_qfam(cand, qfam, ts)) continue;
        if (want_index >= 0 && (long)idx != want_index) continue;
        if (!want_substr.empty()) {
            VkPhysicalDeviceProperties p; vkGetPhysicalDeviceProperties(cand, &p);
            std::string nm = p.deviceName;
            for (char & c : nm) c = (char)std::tolower((unsigned char)c);
            if (nm.find(want_substr) == std::string::npos) continue;
        }
        v.pd = cand; v.qfam = qfam; v.ts_supported = ts;
        break;
    }
    if (v.pd == VK_NULL_HANDLE) { std::fprintf(stderr, "no matching compute-capable Vulkan device\n"); std::exit(1); }
    VkPhysicalDeviceProperties props; vkGetPhysicalDeviceProperties(v.pd, &props);
    v.ts_period_ns = props.limits.timestampPeriod;
    v.device_name = props.deviceName;
    v.vendor_id = props.vendorID; v.device_id = props.deviceID;
    if (!software_vulkan_allowed() && looks_like_software_vulkan_device(props.deviceName)) {
        std::fprintf(stderr, "[vulkan_bench] refusing software Vulkan device '%s'. "
                             "Set ELIZA_ALLOW_SOFTWARE_VULKAN=1 for diagnostics only.\n", props.deviceName);
        std::exit(2);
    }
    // Subgroup size (informational — the kernels are subgroup-agnostic, but the
    // device-policy table records it so future subgroup work knows the value).
    VkPhysicalDeviceSubgroupProperties sg{}; sg.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SUBGROUP_PROPERTIES;
    VkPhysicalDeviceProperties2 p2{}; p2.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2; p2.pNext = &sg;
    vkGetPhysicalDeviceProperties2(v.pd, &p2);
    v.subgroup_size = sg.subgroupSize;

    float prio = 1.0f;
    VkDeviceQueueCreateInfo qci{}; qci.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
    qci.queueFamilyIndex = v.qfam; qci.queueCount = 1; qci.pQueuePriorities = &prio;
    VkDeviceCreateInfo dci{}; dci.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
    dci.queueCreateInfoCount = 1; dci.pQueueCreateInfos = &qci;
    uint32_t dec = 0; vkEnumerateDeviceExtensionProperties(v.pd, nullptr, &dec, nullptr);
    std::vector<VkExtensionProperties> de(dec); vkEnumerateDeviceExtensionProperties(v.pd, nullptr, &dec, de.data());
    std::vector<const char *> ede;
    for (auto & e : de) if (std::strcmp(e.extensionName, "VK_KHR_portability_subset") == 0) ede.push_back("VK_KHR_portability_subset");
    dci.enabledExtensionCount = (uint32_t)ede.size(); dci.ppEnabledExtensionNames = ede.empty() ? nullptr : ede.data();
    VK_CHECK(vkCreateDevice(v.pd, &dci, nullptr, &v.device));
    vkGetDeviceQueue(v.device, v.qfam, 0, &v.queue);
    return v;
}

struct Buf { VkBuffer buf = VK_NULL_HANDLE; VkDeviceMemory mem = VK_NULL_HANDLE; void * mapped = nullptr; VkDeviceSize size = 0; };

static uint32_t find_mem(const Vk & v, uint32_t type_bits, VkMemoryPropertyFlags want) {
    VkPhysicalDeviceMemoryProperties mp; vkGetPhysicalDeviceMemoryProperties(v.pd, &mp);
    for (uint32_t i = 0; i < mp.memoryTypeCount; i++)
        if ((type_bits & (1u << i)) && (mp.memoryTypes[i].propertyFlags & want) == want) return i;
    std::fprintf(stderr, "no compatible memory type\n"); std::exit(1);
}
static Buf alloc_buf(const Vk & v, VkDeviceSize bytes) {
    Buf b{}; b.size = bytes == 0 ? 4 : bytes;
    VkBufferCreateInfo bi{}; bi.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
    bi.size = b.size; bi.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT; bi.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    VK_CHECK(vkCreateBuffer(v.device, &bi, nullptr, &b.buf));
    VkMemoryRequirements mr; vkGetBufferMemoryRequirements(v.device, b.buf, &mr);
    VkMemoryAllocateInfo mi{}; mi.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO; mi.allocationSize = mr.size;
    mi.memoryTypeIndex = find_mem(v, mr.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
    VK_CHECK(vkAllocateMemory(v.device, &mi, nullptr, &b.mem));
    VK_CHECK(vkBindBufferMemory(v.device, b.buf, b.mem, 0));
    VK_CHECK(vkMapMemory(v.device, b.mem, 0, b.size, 0, &b.mapped));
    std::memset(b.mapped, 0, (size_t)b.size);
    return b;
}
static void free_buf(const Vk & v, Buf & b) {
    if (b.mapped) vkUnmapMemory(v.device, b.mem);
    if (b.buf) vkDestroyBuffer(v.device, b.buf, nullptr);
    if (b.mem) vkFreeMemory(v.device, b.mem, nullptr);
    b = Buf{};
}

// A configured dispatch: SPIR-V, bind set, push constants, grid, optional
// spec constant (constant_id 0). Owns nothing — buffers passed in.
struct DispatchCfg {
    std::vector<uint8_t> spv;
    std::vector<const Buf *> bindings;     // descriptor slots 0..n-1
    std::vector<uint8_t> push_bytes;
    uint32_t gx = 1, gy = 1, gz = 1;
    bool has_spec = false;
    uint32_t spec_value = 1;
};

// Build pipeline + descriptor set + command buffer with timestamp queries,
// run warm-up + N measured submits, return median GPU time in microseconds.
static double bench_dispatch(const Vk & v, const DispatchCfg & cfg, int warmup, int runs) {
    const uint32_t n_bind = (uint32_t)cfg.bindings.size();
    std::vector<VkDescriptorSetLayoutBinding> dslb(n_bind);
    for (uint32_t i = 0; i < n_bind; i++) { dslb[i] = {}; dslb[i].binding = i; dslb[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER; dslb[i].descriptorCount = 1; dslb[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT; }
    VkDescriptorSetLayoutCreateInfo dslci{}; dslci.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO; dslci.bindingCount = n_bind; dslci.pBindings = dslb.data();
    VkDescriptorSetLayout dsl; VK_CHECK(vkCreateDescriptorSetLayout(v.device, &dslci, nullptr, &dsl));

    VkPushConstantRange pcr{}; pcr.stageFlags = VK_SHADER_STAGE_COMPUTE_BIT; pcr.offset = 0; pcr.size = (uint32_t)cfg.push_bytes.size();
    VkPipelineLayoutCreateInfo plci{}; plci.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
    plci.setLayoutCount = 1; plci.pSetLayouts = &dsl;
    if (!cfg.push_bytes.empty()) { plci.pushConstantRangeCount = 1; plci.pPushConstantRanges = &pcr; }
    VkPipelineLayout pll; VK_CHECK(vkCreatePipelineLayout(v.device, &plci, nullptr, &pll));

    VkShaderModuleCreateInfo smci{}; smci.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO; smci.codeSize = cfg.spv.size(); smci.pCode = (const uint32_t *)cfg.spv.data();
    VkShaderModule sm; VK_CHECK(vkCreateShaderModule(v.device, &smci, nullptr, &sm));

    VkSpecializationMapEntry spec_entry{ 0, 0, sizeof(uint32_t) };
    VkSpecializationInfo spec_info{ 1, &spec_entry, sizeof(uint32_t), &cfg.spec_value };
    VkComputePipelineCreateInfo cpci{}; cpci.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO;
    cpci.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO; cpci.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
    cpci.stage.module = sm; cpci.stage.pName = "main"; cpci.stage.pSpecializationInfo = cfg.has_spec ? &spec_info : nullptr; cpci.layout = pll;
    VkPipeline pipeline; VK_CHECK(vkCreateComputePipelines(v.device, VK_NULL_HANDLE, 1, &cpci, nullptr, &pipeline));

    VkDescriptorPoolSize dps{ VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, n_bind };
    VkDescriptorPoolCreateInfo dpci{}; dpci.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO; dpci.maxSets = 1; dpci.poolSizeCount = 1; dpci.pPoolSizes = &dps;
    VkDescriptorPool dp; VK_CHECK(vkCreateDescriptorPool(v.device, &dpci, nullptr, &dp));
    VkDescriptorSetAllocateInfo dsai{}; dsai.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO; dsai.descriptorPool = dp; dsai.descriptorSetCount = 1; dsai.pSetLayouts = &dsl;
    VkDescriptorSet ds; VK_CHECK(vkAllocateDescriptorSets(v.device, &dsai, &ds));
    std::vector<VkDescriptorBufferInfo> bi(n_bind); std::vector<VkWriteDescriptorSet> wds(n_bind);
    for (uint32_t i = 0; i < n_bind; i++) {
        bi[i] = { cfg.bindings[i]->buf, 0, VK_WHOLE_SIZE };
        wds[i] = {}; wds[i].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET; wds[i].dstSet = ds; wds[i].dstBinding = i; wds[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER; wds[i].descriptorCount = 1; wds[i].pBufferInfo = &bi[i];
    }
    vkUpdateDescriptorSets(v.device, n_bind, wds.data(), 0, nullptr);

    VkQueryPoolCreateInfo qpci{}; qpci.sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO; qpci.queryType = VK_QUERY_TYPE_TIMESTAMP; qpci.queryCount = 2;
    VkQueryPool qpool; VK_CHECK(vkCreateQueryPool(v.device, &qpci, nullptr, &qpool));

    VkCommandPoolCreateInfo cpinf{}; cpinf.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO; cpinf.queueFamilyIndex = v.qfam; cpinf.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    VkCommandPool cmdpool; VK_CHECK(vkCreateCommandPool(v.device, &cpinf, nullptr, &cmdpool));
    VkCommandBufferAllocateInfo cbai{}; cbai.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO; cbai.commandPool = cmdpool; cbai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY; cbai.commandBufferCount = 1;
    VkCommandBuffer cb; VK_CHECK(vkAllocateCommandBuffers(v.device, &cbai, &cb));

    auto record_and_submit = [&](bool with_ts) {
        VkCommandBufferBeginInfo cbi{}; cbi.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO; cbi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
        VK_CHECK(vkBeginCommandBuffer(cb, &cbi));
        if (with_ts) vkCmdResetQueryPool(cb, qpool, 0, 2);
        vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
        vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pll, 0, 1, &ds, 0, nullptr);
        if (!cfg.push_bytes.empty()) vkCmdPushConstants(cb, pll, VK_SHADER_STAGE_COMPUTE_BIT, 0, (uint32_t)cfg.push_bytes.size(), cfg.push_bytes.data());
        if (with_ts) vkCmdWriteTimestamp(cb, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, qpool, 0);
        vkCmdDispatch(cb, cfg.gx, cfg.gy, cfg.gz);
        if (with_ts) vkCmdWriteTimestamp(cb, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, qpool, 1);
        VK_CHECK(vkEndCommandBuffer(cb));
        VkSubmitInfo si{}; si.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO; si.commandBufferCount = 1; si.pCommandBuffers = &cb;
        VK_CHECK(vkQueueSubmit(v.queue, 1, &si, VK_NULL_HANDLE));
        VK_CHECK(vkQueueWaitIdle(v.queue));
    };

    for (int i = 0; i < warmup; i++) record_and_submit(false);

    std::vector<double> us; us.reserve(runs);
    for (int i = 0; i < runs; i++) {
        record_and_submit(true);
        uint64_t ts[2] = { 0, 0 };
        VkResult qr = vkGetQueryPoolResults(v.device, qpool, 0, 2, sizeof(ts), ts, sizeof(uint64_t),
                                            VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT);
        if (qr == VK_SUCCESS && ts[1] >= ts[0]) {
            double ns = (double)(ts[1] - ts[0]) * v.ts_period_ns;
            us.push_back(ns / 1000.0);
        }
    }
    double median = -1.0;
    if (!us.empty()) { std::sort(us.begin(), us.end()); median = us[us.size() / 2]; }

    vkDestroyCommandPool(v.device, cmdpool, nullptr);
    vkDestroyQueryPool(v.device, qpool, nullptr);
    vkDestroyDescriptorPool(v.device, dp, nullptr);
    vkDestroyPipeline(v.device, pipeline, nullptr);
    vkDestroyShaderModule(v.device, sm, nullptr);
    vkDestroyPipelineLayout(v.device, pll, nullptr);
    vkDestroyDescriptorSetLayout(v.device, dsl, nullptr);
    return median;
}

// --- Push-constant layouts (mirror vulkan_verify.cpp). ---
struct TurboPush { uint32_t head_dim, n_kv, kv_stride_blocks, q_head, head_offset_bytes; };
struct QjlPush   { uint32_t n_heads, n_kv_heads, n_tokens, proj_dim; };
struct PolarPush { uint32_t n_rows, head_dim, use_qjl, k_offset_bytes, q_offset, y_offset; };
struct FusedTbqPush   { uint32_t n_heads, n_kv_heads, n_tokens, q_pos, sm_scale_bits, kv_tile, causal, q_pos_base; };
struct FusedPolarPush { uint32_t n_heads, n_kv_heads, n_tokens, q_pos, sm_scale_bits, v_use_qjl, kv_tile, causal, q_pos_base; };

template <typename T> static std::vector<uint8_t> as_bytes(const T & t) {
    return std::vector<uint8_t>((const uint8_t *)&t, (const uint8_t *)&t + sizeof(T));
}

struct Row {
    std::string kernel;     // "turbo3", "turbo3_multi", ...
    std::string spv;
    uint32_t n_kv = 0;      // sequence length (n_tokens / n_rows)
    uint32_t n_heads = 1;
    uint32_t multi = 1;     // spec constant (1 == base)
    double us = -1.0;       // median GPU time
};

static const char * SPV_DIR_DEFAULT = "../vulkan";

static std::string spv_path(const std::string & dir, const char * name) { return dir + "/" + name + ".spv"; }

} // namespace

int main(int argc, char ** argv) {
    std::string json_out;
    if (const char * e = std::getenv("VULKAN_BENCH_JSON")) json_out = e;
    int runs = 9, warmup = 3;
    std::string spv_dir = SPV_DIR_DEFAULT;
    for (int i = 1; i < argc; i++) {
        if (!std::strcmp(argv[i], "--json") && i + 1 < argc) json_out = argv[++i];
        else if (!std::strcmp(argv[i], "--runs") && i + 1 < argc) runs = std::atoi(argv[++i]);
        else if (!std::strcmp(argv[i], "--warmup") && i + 1 < argc) warmup = std::atoi(argv[++i]);
        else if (!std::strcmp(argv[i], "--spv-dir") && i + 1 < argc) spv_dir = argv[++i];
        else { std::fprintf(stderr, "usage: %s [--json out.json] [--runs N] [--warmup W] [--spv-dir DIR]\n", argv[0]); return 2; }
    }
    if (runs < 1) runs = 1;

    Vk v = init_vk();
    std::printf("[vulkan_bench] device=%s api vendor=0x%04x dev=0x%04x subgroupSize=%u timestampPeriod=%.4f ns ts_supported=%d\n",
                v.device_name.c_str(), v.vendor_id, v.device_id, v.subgroup_size, v.ts_period_ns, (int)v.ts_supported);
    if (!v.ts_supported) {
        std::fprintf(stderr, "[vulkan_bench] timestamp queries not supported on the compute queue — cannot measure GPU time.\n");
        return 3;
    }

    // n_kv sweep (resp. n_tokens / n_rows): 512 / 4096 / 32768 covers the
    // 0.8B/2B context tiers.
    const uint32_t NKV[] = { 512u, 4096u, 32768u };
    const uint32_t MULTI[] = { 1u, 2u, 4u, 8u, 16u };

    std::vector<Row> rows;

    // Generic helper: bench a turbo* kernel (base or _multi). q is n_heads*128 fp32.
    auto bench_turbo = [&](const char * base_name, const char * multi_name,
                           uint32_t block_bytes, uint32_t blocks_per_kv, bool needs_codebook) {
        const uint32_t n_heads = 1;
        for (uint32_t n_kv : NKV) {
            // shared buffers per n_kv
            Buf q   = alloc_buf(v, (VkDeviceSize)n_heads * HEAD_DIM * sizeof(float));
            Buf k   = alloc_buf(v, (VkDeviceSize)n_kv * blocks_per_kv * block_bytes + 16);
            Buf out = alloc_buf(v, (VkDeviceSize)n_kv * sizeof(float));
            Buf cbk; if (needs_codebook) cbk = alloc_buf(v, 512 * sizeof(float));
            // base
            {
                DispatchCfg cfg; cfg.spv = load_spirv(spv_path(spv_dir, base_name).c_str());
                cfg.bindings = { &q, &k, &out }; if (needs_codebook) cfg.bindings.push_back(&cbk);
                TurboPush pc{ HEAD_DIM, n_kv, blocks_per_kv, 0, 0 }; cfg.push_bytes = as_bytes(pc);
                cfg.gx = n_kv; cfg.gy = 1; cfg.gz = 1;
                double us = bench_dispatch(v, cfg, warmup, runs);
                rows.push_back(Row{ base_name, spv_path(spv_dir, base_name), n_kv, n_heads, 1, us });
                std::printf("  %-16s n_kv=%-6u multi=1   %.2f us\n", base_name, n_kv, us);
            }
            // _multi sweep
            for (uint32_t m : MULTI) {
                DispatchCfg cfg; cfg.spv = load_spirv(spv_path(spv_dir, multi_name).c_str());
                cfg.bindings = { &q, &k, &out }; if (needs_codebook) cfg.bindings.push_back(&cbk);
                TurboPush pc{ HEAD_DIM, n_kv, blocks_per_kv, 0, 0 }; cfg.push_bytes = as_bytes(pc);
                cfg.gx = (n_kv + m - 1) / m; cfg.gy = 1; cfg.gz = 1;
                cfg.has_spec = true; cfg.spec_value = m;
                double us = bench_dispatch(v, cfg, warmup, runs);
                rows.push_back(Row{ multi_name, spv_path(spv_dir, multi_name), n_kv, n_heads, m, us });
                std::printf("  %-16s n_kv=%-6u multi=%-2u  %.2f us\n", multi_name, n_kv, m, us);
            }
            free_buf(v, q); free_buf(v, k); free_buf(v, out); if (needs_codebook) free_buf(v, cbk);
        }
    };

    bench_turbo("turbo3",     "turbo3_multi",     TURBO3_BLOCK,     4, false);
    bench_turbo("turbo4",     "turbo4_multi",     TURBO4_BLOCK,     4, false);
    bench_turbo("turbo3_tcq", "turbo3_tcq_multi", TURBO3_TCQ_BLOCK, 1, true);

    // QJL (n_heads x n_tokens grid). Bench n_heads=8 to mirror the 2B head count
    // ballpark while keeping the buffers small.
    {
        const uint32_t n_heads = 8, n_kv_heads = 2;
        for (uint32_t n_tok : NKV) {
            Buf qs  = alloc_buf(v, (VkDeviceSize)n_heads * QJL_PROJ_DIM * sizeof(float));
            Buf k   = alloc_buf(v, (VkDeviceSize)n_kv_heads * n_tok * QJL_BLOCK + 16);
            Buf out = alloc_buf(v, (VkDeviceSize)n_heads * n_tok * sizeof(float));
            {
                DispatchCfg cfg; cfg.spv = load_spirv(spv_path(spv_dir, "qjl").c_str());
                cfg.bindings = { &qs, &k, &out };
                QjlPush pc{ n_heads, n_kv_heads, n_tok, QJL_PROJ_DIM }; cfg.push_bytes = as_bytes(pc);
                cfg.gx = n_heads; cfg.gy = n_tok; cfg.gz = 1;
                double us = bench_dispatch(v, cfg, warmup, runs);
                rows.push_back(Row{ "qjl", spv_path(spv_dir, "qjl"), n_tok, n_heads, 1, us });
                std::printf("  %-16s n_tok=%-6u multi=1   %.2f us\n", "qjl", n_tok, us);
            }
            for (uint32_t m : MULTI) {
                DispatchCfg cfg; cfg.spv = load_spirv(spv_path(spv_dir, "qjl_multi").c_str());
                cfg.bindings = { &qs, &k, &out };
                QjlPush pc{ n_heads, n_kv_heads, n_tok, QJL_PROJ_DIM }; cfg.push_bytes = as_bytes(pc);
                cfg.gx = n_heads; cfg.gy = (n_tok + m - 1) / m; cfg.gz = 1;
                cfg.has_spec = true; cfg.spec_value = m;
                double us = bench_dispatch(v, cfg, warmup, runs);
                rows.push_back(Row{ "qjl_multi", spv_path(spv_dir, "qjl_multi"), n_tok, n_heads, m, us });
                std::printf("  %-16s n_tok=%-6u multi=%-2u  %.2f us\n", "qjl_multi", n_tok, m, us);
            }
            free_buf(v, qs); free_buf(v, k); free_buf(v, out);
        }
    }

    // Polar + polar_preht (n_rows grid). bind set = {k_blocks, q, y}.
    auto bench_polar = [&](const char * name) {
        for (uint32_t n_rows : NKV) {
            Buf k = alloc_buf(v, (VkDeviceSize)n_rows * POLAR_BLOCK + 16);
            Buf q = alloc_buf(v, (VkDeviceSize)HEAD_DIM * sizeof(float));
            Buf y = alloc_buf(v, (VkDeviceSize)n_rows * sizeof(float));
            DispatchCfg cfg; cfg.spv = load_spirv(spv_path(spv_dir, name).c_str());
            cfg.bindings = { &k, &q, &y };
            PolarPush pc{ n_rows, HEAD_DIM, 1u, 0, 0, 0 }; cfg.push_bytes = as_bytes(pc);
            cfg.gx = n_rows; cfg.gy = 1; cfg.gz = 1;
            double us = bench_dispatch(v, cfg, warmup, runs);
            rows.push_back(Row{ name, spv_path(spv_dir, name), n_rows, 1, 1, us });
            std::printf("  %-16s n_rows=%-6u multi=1   %.2f us\n", name, n_rows, us);
            free_buf(v, k); free_buf(v, q); free_buf(v, y);
        }
    };
    bench_polar("polar");
    bench_polar("polar_preht");

    // Fused attention: one workgroup per head, walks all n_kv internally.
    // Bench n_heads=8, n_kv_heads=2 (GQA 4). kv_tile sweep is informational —
    // the current shader treats 0 == whole range, so vary it just to confirm it
    // doesn't change timing (it's wired to subdivide pass 1/2 in the runtime).
    auto bench_fused = [&](const char * name, bool is_polar) {
        const uint32_t n_heads = 8, n_kv_heads = 2;
        for (uint32_t n_kv : NKV) {
            Buf qs  = alloc_buf(v, (VkDeviceSize)n_heads * QJL_PROJ_DIM * sizeof(float));
            Buf k   = alloc_buf(v, (VkDeviceSize)n_kv_heads * n_kv * QJL_BLOCK + 16);
            const uint32_t v_token_bytes = is_polar ? POLAR_BLOCK : TBQ_TOKEN_BYTES;
            Buf vv  = alloc_buf(v, (VkDeviceSize)n_kv_heads * n_kv * v_token_bytes + 16);
            Buf out = alloc_buf(v, (VkDeviceSize)n_heads * HEAD_DIM * sizeof(float));
            float sm_scale = 0.08838f;
            uint32_t sm_bits = 0; std::memcpy(&sm_bits, &sm_scale, sizeof(uint32_t));
            DispatchCfg cfg; cfg.spv = load_spirv(spv_path(spv_dir, name).c_str());
            cfg.bindings = { &qs, &k, &vv, &out };
            if (is_polar) { FusedPolarPush pc{ n_heads, n_kv_heads, n_kv, 0, sm_bits, 1u, 0u, 0u, 0u }; cfg.push_bytes = as_bytes(pc); }
            else          { FusedTbqPush   pc{ n_heads, n_kv_heads, n_kv, 0, sm_bits, 0u, 0u, 0u };     cfg.push_bytes = as_bytes(pc); }
            cfg.gx = n_heads; cfg.gy = 1; cfg.gz = 1;
            double us = bench_dispatch(v, cfg, warmup, runs);
            rows.push_back(Row{ name, spv_path(spv_dir, name), n_kv, n_heads, 1, us });
            std::printf("  %-22s n_kv=%-6u            %.2f us\n", name, n_kv, us);
            free_buf(v, qs); free_buf(v, k); free_buf(v, vv); free_buf(v, out);
        }
    };
    bench_fused("fused_attn_qjl_tbq",   false);
    bench_fused("fused_attn_qjl_polar", true);

    // --- JSON out ---
    if (!json_out.empty()) {
        std::ofstream f(json_out);
        if (!f) { std::fprintf(stderr, "[vulkan_bench] cannot write %s\n", json_out.c_str()); return 4; }
        f << "{\n";
        f << "  \"device\": \"" << v.device_name << "\",\n";
        f << "  \"vendorID\": " << v.vendor_id << ",\n";
        f << "  \"deviceID\": " << v.device_id << ",\n";
        f << "  \"subgroupSize\": " << v.subgroup_size << ",\n";
        f << "  \"timestampPeriodNs\": " << v.ts_period_ns << ",\n";
        f << "  \"runs\": " << runs << ", \"warmup\": " << warmup << ",\n";
        f << "  \"rows\": [\n";
        for (size_t i = 0; i < rows.size(); i++) {
            const Row & r = rows[i];
            f << "    {\"kernel\": \"" << r.kernel << "\", \"n_kv\": " << r.n_kv
              << ", \"n_heads\": " << r.n_heads << ", \"multi\": " << r.multi
              << ", \"us\": " << r.us << "}";
            f << (i + 1 < rows.size() ? ",\n" : "\n");
        }
        f << "  ]\n}\n";
        std::printf("[vulkan_bench] wrote %s (%zu rows)\n", json_out.c_str(), rows.size());
    }

    vkDestroyDevice(v.device, nullptr);
    vkDestroyInstance(v.instance, nullptr);
    return 0;
}
