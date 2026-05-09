// DRAFT: NOT VALIDATED ON HARDWARE — see kernels/README.md
//
// Host-side Vulkan verification harness for the turbo3 / turbo4 / turbo3_tcq
// compute shaders. Loads the JSON fixture written by gen_fixture, runs the
// shader against the supplied Q + K_blocks, and compares scalar scores
// against the reference (tolerance: 1e-3 absolute).
//
// Build (only when VULKAN_SDK is set):
//     VULKAN_SDK=/opt/vulkan-sdk make vulkan
//
// Run:
//     ./vulkan_verify ../vulkan/turbo4.spv fixtures/turbo4.json
//
// The harness expects pre-compiled SPIR-V. To compile the shaders:
//     glslc -fshader-stage=compute ../vulkan/turbo3.comp     -o ../vulkan/turbo3.spv
//     glslc -fshader-stage=compute ../vulkan/turbo4.comp     -o ../vulkan/turbo4.spv
//     glslc -fshader-stage=compute ../vulkan/turbo3_tcq.comp -o ../vulkan/turbo3_tcq.spv
// Or via glslangValidator:
//     glslangValidator -V -S comp ../vulkan/turbo3.comp -o ../vulkan/turbo3.spv
//
// This file is intentionally compact — it is meant to run on a developer's
// laptop with a Vulkan-capable GPU, not in a complex build pipeline.

#include "turbo_kernels.h"

#include <vulkan/vulkan.h>

#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
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

struct Fixture {
    std::string kernel;
    int head_dim;
    int n_kv;
    int block_bytes;
    int blocks_per_kv;
    std::vector<float> q;
    std::vector<uint8_t> k_blocks;
    std::vector<float> expected_scores;
};

// Minimal JSON value parser — fixture format is fixed and trusted, so we keep
// it tiny rather than pull in a dependency.
static std::string slurp(const char * path) {
    std::ifstream f(path);
    if (!f) { std::fprintf(stderr, "cannot open %s\n", path); std::exit(1); }
    std::stringstream ss; ss << f.rdbuf(); return ss.str();
}

static const char * find_key(const std::string & s, const char * key, size_t & pos) {
    std::string needle = std::string("\"") + key + "\"";
    size_t k = s.find(needle, pos);
    if (k == std::string::npos) return nullptr;
    size_t colon = s.find(':', k);
    pos = colon + 1;
    while (pos < s.size() && std::isspace((unsigned char)s[pos])) pos++;
    return s.c_str() + pos;
}

static int parse_int(const std::string & s, size_t & pos) {
    while (pos < s.size() && std::isspace((unsigned char)s[pos])) pos++;
    char * end = nullptr;
    long v = std::strtol(s.c_str() + pos, &end, 10);
    pos = (size_t)(end - s.c_str());
    return (int)v;
}

static std::vector<float> parse_float_array(const std::string & s, size_t & pos) {
    while (s[pos] != '[') pos++;
    pos++;
    std::vector<float> out;
    while (s[pos] != ']') {
        char * end = nullptr;
        float v = std::strtof(s.c_str() + pos, &end);
        out.push_back(v);
        pos = (size_t)(end - s.c_str());
        while (s[pos] == ',' || std::isspace((unsigned char)s[pos])) pos++;
    }
    pos++;
    return out;
}

static std::vector<uint8_t> parse_byte_array(const std::string & s, size_t & pos) {
    while (s[pos] != '[') pos++;
    pos++;
    std::vector<uint8_t> out;
    while (s[pos] != ']') {
        char * end = nullptr;
        long v = std::strtol(s.c_str() + pos, &end, 10);
        out.push_back((uint8_t)v);
        pos = (size_t)(end - s.c_str());
        while (s[pos] == ',' || std::isspace((unsigned char)s[pos])) pos++;
    }
    pos++;
    return out;
}

static std::string parse_string(const std::string & s, size_t & pos) {
    while (s[pos] != '"') pos++;
    pos++;
    size_t start = pos;
    while (s[pos] != '"') pos++;
    std::string out = s.substr(start, pos - start);
    pos++;
    return out;
}

static Fixture load_fixture(const char * path) {
    std::string s = slurp(path);
    Fixture fx;
    size_t pos = 0;
    find_key(s, "kernel", pos);          fx.kernel = parse_string(s, pos);
    find_key(s, "head_dim", pos);        fx.head_dim = parse_int(s, pos);
    find_key(s, "n_kv", pos);            fx.n_kv = parse_int(s, pos);
    find_key(s, "block_bytes", pos);     fx.block_bytes = parse_int(s, pos);
    find_key(s, "blocks_per_kv", pos);   fx.blocks_per_kv = parse_int(s, pos);
    find_key(s, "q", pos);               fx.q = parse_float_array(s, pos);
    find_key(s, "k_blocks", pos);        fx.k_blocks = parse_byte_array(s, pos);
    find_key(s, "expected_scores", pos); fx.expected_scores = parse_float_array(s, pos);
    return fx;
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

struct PushConsts {
    uint32_t head_dim;
    uint32_t n_kv;
    uint32_t kv_stride_blocks;
    uint32_t q_head;
    uint32_t head_offset_bytes;
};

} // namespace

int main(int argc, char ** argv) {
    if (argc < 3) {
        std::fprintf(stderr, "usage: %s <kernel.spv> <fixture.json> [tolerance=1e-3]\n", argv[0]);
        return 2;
    }
    const char * spv_path = argv[1];
    const char * fx_path  = argv[2];
    float tol = argc >= 4 ? std::strtof(argv[3], nullptr) : 1e-3f;

    Fixture fx = load_fixture(fx_path);
    std::printf("[vulkan_verify] kernel=%s n_kv=%d head_dim=%d\n",
                fx.kernel.c_str(), fx.n_kv, fx.head_dim);

    // Whether a 4th storage buffer for codebook is needed.
    bool needs_codebook = (fx.kernel == "turbo3_tcq");

    // --- Vulkan instance ---
    VkApplicationInfo ai{};
    ai.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
    ai.pApplicationName = "eliza-turbo-verify";
    ai.apiVersion = VK_API_VERSION_1_2;
    VkInstanceCreateInfo ici{};
    ici.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
    ici.pApplicationInfo = &ai;
    VkInstance instance;
    VK_CHECK(vkCreateInstance(&ici, nullptr, &instance));

    // --- Pick first physical device with a compute queue ---
    uint32_t pd_count = 0;
    VK_CHECK(vkEnumeratePhysicalDevices(instance, &pd_count, nullptr));
    if (pd_count == 0) { std::fprintf(stderr, "no Vulkan devices\n"); return 1; }
    std::vector<VkPhysicalDevice> pds(pd_count);
    VK_CHECK(vkEnumeratePhysicalDevices(instance, &pd_count, pds.data()));
    VkPhysicalDevice pd = pds[0];

    uint32_t qfam_count = 0;
    vkGetPhysicalDeviceQueueFamilyProperties(pd, &qfam_count, nullptr);
    std::vector<VkQueueFamilyProperties> qfams(qfam_count);
    vkGetPhysicalDeviceQueueFamilyProperties(pd, &qfam_count, qfams.data());
    uint32_t qfam = (uint32_t)-1;
    for (uint32_t i = 0; i < qfam_count; i++) {
        if (qfams[i].queueFlags & VK_QUEUE_COMPUTE_BIT) { qfam = i; break; }
    }
    if (qfam == (uint32_t)-1) { std::fprintf(stderr, "no compute queue\n"); return 1; }

    float prio = 1.0f;
    VkDeviceQueueCreateInfo qci{};
    qci.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
    qci.queueFamilyIndex = qfam;
    qci.queueCount = 1;
    qci.pQueuePriorities = &prio;
    VkDeviceCreateInfo dci{};
    dci.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
    dci.queueCreateInfoCount = 1;
    dci.pQueueCreateInfos = &qci;
    VkDevice device;
    VK_CHECK(vkCreateDevice(pd, &dci, nullptr, &device));
    VkQueue queue;
    vkGetDeviceQueue(device, qfam, 0, &queue);

    // --- Helper: allocate a host-visible buffer + memory ---
    auto find_mem = [&](uint32_t type_bits, VkMemoryPropertyFlags want) {
        VkPhysicalDeviceMemoryProperties props;
        vkGetPhysicalDeviceMemoryProperties(pd, &props);
        for (uint32_t i = 0; i < props.memoryTypeCount; i++) {
            if ((type_bits & (1 << i)) &&
                (props.memoryTypes[i].propertyFlags & want) == want) {
                return i;
            }
        }
        std::fprintf(stderr, "no compatible memory type\n"); std::exit(1);
    };
    struct Buf { VkBuffer buf; VkDeviceMemory mem; void * mapped; VkDeviceSize size; };
    auto alloc_buf = [&](VkDeviceSize bytes, VkBufferUsageFlags usage) {
        Buf b{};
        b.size = bytes;
        VkBufferCreateInfo bi{};
        bi.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
        bi.size = bytes; bi.usage = usage;
        bi.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
        VK_CHECK(vkCreateBuffer(device, &bi, nullptr, &b.buf));
        VkMemoryRequirements mr;
        vkGetBufferMemoryRequirements(device, b.buf, &mr);
        VkMemoryAllocateInfo mi{};
        mi.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
        mi.allocationSize = mr.size;
        mi.memoryTypeIndex = find_mem(mr.memoryTypeBits,
            VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
        VK_CHECK(vkAllocateMemory(device, &mi, nullptr, &b.mem));
        VK_CHECK(vkBindBufferMemory(device, b.buf, b.mem, 0));
        VK_CHECK(vkMapMemory(device, b.mem, 0, bytes, 0, &b.mapped));
        return b;
    };

    Buf q_buf      = alloc_buf(fx.q.size() * sizeof(float),         VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    Buf k_buf      = alloc_buf(fx.k_blocks.size(),                   VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    Buf scores_buf = alloc_buf(fx.n_kv * sizeof(float),              VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    std::memcpy(q_buf.mapped, fx.q.data(), q_buf.size);
    std::memcpy(k_buf.mapped, fx.k_blocks.data(), k_buf.size);
    std::memset(scores_buf.mapped, 0, scores_buf.size);

    Buf cb_buf{};
    if (needs_codebook) {
        cb_buf = alloc_buf(512 * sizeof(float), VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
        std::memcpy(cb_buf.mapped, ELIZA_TURBO3_TCQ_CODEBOOK, 512 * sizeof(float));
    }

    // --- Descriptor set layout / pool / set ---
    uint32_t n_bindings = needs_codebook ? 4 : 3;
    std::vector<VkDescriptorSetLayoutBinding> dslb(n_bindings);
    for (uint32_t i = 0; i < n_bindings; i++) {
        dslb[i].binding = i;
        dslb[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
        dslb[i].descriptorCount = 1;
        dslb[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
    }
    VkDescriptorSetLayoutCreateInfo dslci{};
    dslci.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
    dslci.bindingCount = n_bindings;
    dslci.pBindings = dslb.data();
    VkDescriptorSetLayout dsl;
    VK_CHECK(vkCreateDescriptorSetLayout(device, &dslci, nullptr, &dsl));

    VkDescriptorPoolSize dps{ VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, n_bindings };
    VkDescriptorPoolCreateInfo dpci{};
    dpci.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
    dpci.maxSets = 1;
    dpci.poolSizeCount = 1; dpci.pPoolSizes = &dps;
    VkDescriptorPool dp;
    VK_CHECK(vkCreateDescriptorPool(device, &dpci, nullptr, &dp));

    VkDescriptorSetAllocateInfo dsai{};
    dsai.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
    dsai.descriptorPool = dp;
    dsai.descriptorSetCount = 1;
    dsai.pSetLayouts = &dsl;
    VkDescriptorSet ds;
    VK_CHECK(vkAllocateDescriptorSets(device, &dsai, &ds));

    std::vector<VkDescriptorBufferInfo> bi(n_bindings);
    bi[0] = { q_buf.buf, 0, VK_WHOLE_SIZE };
    bi[1] = { k_buf.buf, 0, VK_WHOLE_SIZE };
    bi[2] = { scores_buf.buf, 0, VK_WHOLE_SIZE };
    if (needs_codebook) bi[3] = { cb_buf.buf, 0, VK_WHOLE_SIZE };
    std::vector<VkWriteDescriptorSet> wds(n_bindings);
    for (uint32_t i = 0; i < n_bindings; i++) {
        wds[i] = {};
        wds[i].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
        wds[i].dstSet = ds;
        wds[i].dstBinding = i;
        wds[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
        wds[i].descriptorCount = 1;
        wds[i].pBufferInfo = &bi[i];
    }
    vkUpdateDescriptorSets(device, n_bindings, wds.data(), 0, nullptr);

    // --- Shader module ---
    auto spv = load_spirv(spv_path);
    VkShaderModuleCreateInfo smci{};
    smci.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
    smci.codeSize = spv.size();
    smci.pCode = (const uint32_t *)spv.data();
    VkShaderModule sm;
    VK_CHECK(vkCreateShaderModule(device, &smci, nullptr, &sm));

    // --- Pipeline layout w/ push constants ---
    VkPushConstantRange pcr{};
    pcr.stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
    pcr.offset = 0;
    pcr.size = sizeof(PushConsts);
    VkPipelineLayoutCreateInfo plci{};
    plci.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
    plci.setLayoutCount = 1; plci.pSetLayouts = &dsl;
    plci.pushConstantRangeCount = 1; plci.pPushConstantRanges = &pcr;
    VkPipelineLayout pll;
    VK_CHECK(vkCreatePipelineLayout(device, &plci, nullptr, &pll));

    VkComputePipelineCreateInfo cpci{};
    cpci.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO;
    cpci.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    cpci.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
    cpci.stage.module = sm;
    cpci.stage.pName = "main";
    cpci.layout = pll;
    VkPipeline pipeline;
    VK_CHECK(vkCreateComputePipelines(device, VK_NULL_HANDLE, 1, &cpci, nullptr, &pipeline));

    // --- Command buffer ---
    VkCommandPoolCreateInfo cpi{};
    cpi.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
    cpi.queueFamilyIndex = qfam;
    VkCommandPool pool;
    VK_CHECK(vkCreateCommandPool(device, &cpi, nullptr, &pool));
    VkCommandBufferAllocateInfo cbai{};
    cbai.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
    cbai.commandPool = pool;
    cbai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    cbai.commandBufferCount = 1;
    VkCommandBuffer cb;
    VK_CHECK(vkAllocateCommandBuffers(device, &cbai, &cb));

    VkCommandBufferBeginInfo cbi{};
    cbi.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
    cbi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    VK_CHECK(vkBeginCommandBuffer(cb, &cbi));
    vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
    vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pll, 0, 1, &ds, 0, nullptr);

    PushConsts pc{};
    pc.head_dim = (uint32_t)fx.head_dim;
    pc.n_kv = (uint32_t)fx.n_kv;
    pc.kv_stride_blocks = (uint32_t)fx.blocks_per_kv;
    pc.q_head = 0;
    pc.head_offset_bytes = 0;
    vkCmdPushConstants(cb, pll, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(pc), &pc);
    vkCmdDispatch(cb, (uint32_t)fx.n_kv, 1, 1);
    VK_CHECK(vkEndCommandBuffer(cb));

    VkSubmitInfo si{};
    si.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    si.commandBufferCount = 1; si.pCommandBuffers = &cb;
    VK_CHECK(vkQueueSubmit(queue, 1, &si, VK_NULL_HANDLE));
    VK_CHECK(vkQueueWaitIdle(queue));

    // --- Compare ---
    const float * out = (const float *)scores_buf.mapped;
    int failures = 0;
    for (int i = 0; i < fx.n_kv; i++) {
        float diff = std::fabs(out[i] - fx.expected_scores[i]);
        const char * tag = (diff < tol) ? "PASS" : "FAIL";
        std::printf("  kv=%d expected=%+.6f got=%+.6f diff=%.3e %s\n",
                    i, (double)fx.expected_scores[i], (double)out[i], (double)diff, tag);
        if (diff >= tol) failures++;
    }

    std::printf("[vulkan_verify] %s — %d/%d passed (tol=%.0e)\n",
                failures == 0 ? "PASS" : "FAIL",
                fx.n_kv - failures, fx.n_kv, (double)tol);
    return failures == 0 ? 0 : 1;
}
