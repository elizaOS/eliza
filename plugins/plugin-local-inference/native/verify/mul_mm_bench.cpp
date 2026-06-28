// mul_mm_bench.cpp — Mali mul_mm optimization R&D harness (#9584 / #9715).
//
// Mali-G715 reports `matrix cores: none` (no VK_KHR_cooperative_matrix), so LLM
// prefill is mul_mat-bound on raw global-memory bandwidth — the #9584 ceiling.
// This bench measures the canonical cooperative-matrix-free win on the real
// device: a shared-memory-tiled mul_mm vs the scalar (one-MAC-per-global-read)
// baseline. It verifies the tiled kernel matches the scalar result (and a CPU
// spot-check), then reports GPU time / GFLOPS / speedup per shape.
//
// Build (arm64, NDK):
//   aarch64-linux-android28-clang++ -O2 -std=c++17 mul_mm_bench.cpp -lvulkan -o mul_mm_bench
// SPIR-V (glslc): ../vulkan/mul_mm_scalar.spv, ../vulkan/mul_mm_tiled.spv
// Run on device: LD_LIBRARY_PATH=. ./mul_mm_bench [--spv-dir DIR] [--runs N]

#include <vulkan/vulkan.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace {

#define VK_CHECK(expr) do { VkResult _r = (expr); if (_r != VK_SUCCESS) { \
    std::fprintf(stderr, "%s failed: %d\n", #expr, (int)_r); std::exit(1); } } while (0)

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
    return d.find("llvmpipe") != std::string::npos || d.find("lavapipe") != std::string::npos ||
           d.find("swiftshader") != std::string::npos;
}

static std::vector<uint8_t> load_spirv(const std::string & path) {
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f) { std::fprintf(stderr, "cannot open SPIR-V %s\n", path.c_str()); std::exit(1); }
    auto sz = (size_t)f.tellg();
    std::vector<uint8_t> bytes(sz);
    f.seekg(0); f.read((char *)bytes.data(), (std::streamsize)sz);
    return bytes;
}

struct Vk {
    VkInstance instance = VK_NULL_HANDLE;
    VkPhysicalDevice pd = VK_NULL_HANDLE;
    uint32_t qfam = (uint32_t)-1;
    VkDevice device = VK_NULL_HANDLE;
    VkQueue queue = VK_NULL_HANDLE;
    double ts_period_ns = 1.0;
    std::string device_name;
};

static Vk init_vk() {
    Vk v;
    VkApplicationInfo ai{}; ai.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
    ai.pApplicationName = "eliza-mul-mm-bench"; ai.apiVersion = VK_API_VERSION_1_2;
    VkInstanceCreateInfo ici{}; ici.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO; ici.pApplicationInfo = &ai;
    VK_CHECK(vkCreateInstance(&ici, nullptr, &v.instance));
    uint32_t pdc = 0; VK_CHECK(vkEnumeratePhysicalDevices(v.instance, &pdc, nullptr));
    if (pdc == 0) { std::fprintf(stderr, "no Vulkan devices\n"); std::exit(1); }
    std::vector<VkPhysicalDevice> pds(pdc); VK_CHECK(vkEnumeratePhysicalDevices(v.instance, &pdc, pds.data()));
    std::string want_substr;
    if (const char * e = std::getenv("ELIZA_VK_DEVICE_SUBSTR")) want_substr = lower_ascii(e);
    for (uint32_t idx = 0; idx < pdc; idx++) {
        uint32_t qc = 0; vkGetPhysicalDeviceQueueFamilyProperties(pds[idx], &qc, nullptr);
        std::vector<VkQueueFamilyProperties> qf(qc); vkGetPhysicalDeviceQueueFamilyProperties(pds[idx], &qc, qf.data());
        uint32_t qfam = (uint32_t)-1;
        for (uint32_t i = 0; i < qc; i++) if (qf[i].queueFlags & VK_QUEUE_COMPUTE_BIT) { qfam = i; break; }
        if (qfam == (uint32_t)-1) continue;
        if (!want_substr.empty()) {
            VkPhysicalDeviceProperties p; vkGetPhysicalDeviceProperties(pds[idx], &p);
            if (lower_ascii(p.deviceName).find(want_substr) == std::string::npos) continue;
        }
        v.pd = pds[idx]; v.qfam = qfam; break;
    }
    if (v.pd == VK_NULL_HANDLE) { std::fprintf(stderr, "no matching compute device\n"); std::exit(1); }
    VkPhysicalDeviceProperties props; vkGetPhysicalDeviceProperties(v.pd, &props);
    v.ts_period_ns = props.limits.timestampPeriod; v.device_name = props.deviceName;
    if (!software_vulkan_allowed() && looks_like_software_vulkan_device(props.deviceName)) {
        std::fprintf(stderr, "[mul_mm_bench] refusing software Vulkan '%s' (set ELIZA_ALLOW_SOFTWARE_VULKAN=1)\n", props.deviceName);
        std::exit(2);
    }
    float prio = 1.0f;
    VkDeviceQueueCreateInfo qci{}; qci.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
    qci.queueFamilyIndex = v.qfam; qci.queueCount = 1; qci.pQueuePriorities = &prio;
    VkDeviceCreateInfo dci{}; dci.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
    dci.queueCreateInfoCount = 1; dci.pQueueCreateInfos = &qci;
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

struct Push { uint32_t M, N, K; };

// Build pipeline + descriptors, run warmup + N timed dispatches, return median GPU microseconds.
static double bench(const Vk & v, const std::vector<uint8_t> & spv,
                    const Buf & A, const Buf & B, const Buf & C, Push pc,
                    uint32_t gx, uint32_t gy, int warmup, int runs) {
    VkDescriptorSetLayoutBinding dslb[3]{};
    for (uint32_t i = 0; i < 3; i++) { dslb[i].binding = i; dslb[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER; dslb[i].descriptorCount = 1; dslb[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT; }
    VkDescriptorSetLayoutCreateInfo dslci{}; dslci.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO; dslci.bindingCount = 3; dslci.pBindings = dslb;
    VkDescriptorSetLayout dsl; VK_CHECK(vkCreateDescriptorSetLayout(v.device, &dslci, nullptr, &dsl));
    VkPushConstantRange pcr{}; pcr.stageFlags = VK_SHADER_STAGE_COMPUTE_BIT; pcr.offset = 0; pcr.size = sizeof(Push);
    VkPipelineLayoutCreateInfo plci{}; plci.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
    plci.setLayoutCount = 1; plci.pSetLayouts = &dsl; plci.pushConstantRangeCount = 1; plci.pPushConstantRanges = &pcr;
    VkPipelineLayout pll; VK_CHECK(vkCreatePipelineLayout(v.device, &plci, nullptr, &pll));
    VkShaderModuleCreateInfo smci{}; smci.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO; smci.codeSize = spv.size(); smci.pCode = (const uint32_t *)spv.data();
    VkShaderModule sm; VK_CHECK(vkCreateShaderModule(v.device, &smci, nullptr, &sm));
    VkComputePipelineCreateInfo cpci{}; cpci.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO;
    cpci.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO; cpci.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
    cpci.stage.module = sm; cpci.stage.pName = "main"; cpci.layout = pll;
    VkPipeline pipeline; VK_CHECK(vkCreateComputePipelines(v.device, VK_NULL_HANDLE, 1, &cpci, nullptr, &pipeline));
    VkDescriptorPoolSize dps{ VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 3 };
    VkDescriptorPoolCreateInfo dpci{}; dpci.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO; dpci.maxSets = 1; dpci.poolSizeCount = 1; dpci.pPoolSizes = &dps;
    VkDescriptorPool dp; VK_CHECK(vkCreateDescriptorPool(v.device, &dpci, nullptr, &dp));
    VkDescriptorSetAllocateInfo dsai{}; dsai.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO; dsai.descriptorPool = dp; dsai.descriptorSetCount = 1; dsai.pSetLayouts = &dsl;
    VkDescriptorSet ds; VK_CHECK(vkAllocateDescriptorSets(v.device, &dsai, &ds));
    const Buf * bufs[3] = { &A, &B, &C };
    VkDescriptorBufferInfo dbi[3]; VkWriteDescriptorSet wds[3]{};
    for (uint32_t i = 0; i < 3; i++) {
        dbi[i] = { bufs[i]->buf, 0, VK_WHOLE_SIZE };
        wds[i].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET; wds[i].dstSet = ds; wds[i].dstBinding = i; wds[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER; wds[i].descriptorCount = 1; wds[i].pBufferInfo = &dbi[i];
    }
    vkUpdateDescriptorSets(v.device, 3, wds, 0, nullptr);
    VkQueryPoolCreateInfo qpci{}; qpci.sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO; qpci.queryType = VK_QUERY_TYPE_TIMESTAMP; qpci.queryCount = 2;
    VkQueryPool qpool; VK_CHECK(vkCreateQueryPool(v.device, &qpci, nullptr, &qpool));
    VkCommandPoolCreateInfo cpinf{}; cpinf.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO; cpinf.queueFamilyIndex = v.qfam; cpinf.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    VkCommandPool cmdpool; VK_CHECK(vkCreateCommandPool(v.device, &cpinf, nullptr, &cmdpool));
    VkCommandBufferAllocateInfo cbai{}; cbai.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO; cbai.commandPool = cmdpool; cbai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY; cbai.commandBufferCount = 1;
    VkCommandBuffer cb; VK_CHECK(vkAllocateCommandBuffers(v.device, &cbai, &cb));
    auto submit = [&](bool ts) {
        VkCommandBufferBeginInfo cbi{}; cbi.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO; cbi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
        VK_CHECK(vkBeginCommandBuffer(cb, &cbi));
        if (ts) vkCmdResetQueryPool(cb, qpool, 0, 2);
        vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipeline);
        vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pll, 0, 1, &ds, 0, nullptr);
        vkCmdPushConstants(cb, pll, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(Push), &pc);
        if (ts) vkCmdWriteTimestamp(cb, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, qpool, 0);
        vkCmdDispatch(cb, gx, gy, 1);
        if (ts) vkCmdWriteTimestamp(cb, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, qpool, 1);
        VK_CHECK(vkEndCommandBuffer(cb));
        VkSubmitInfo si{}; si.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO; si.commandBufferCount = 1; si.pCommandBuffers = &cb;
        VK_CHECK(vkQueueSubmit(v.queue, 1, &si, VK_NULL_HANDLE));
        VK_CHECK(vkQueueWaitIdle(v.queue));
    };
    for (int i = 0; i < warmup; i++) submit(false);
    std::vector<double> us;
    for (int i = 0; i < runs; i++) {
        submit(true);
        uint64_t ts[2] = { 0, 0 };
        if (vkGetQueryPoolResults(v.device, qpool, 0, 2, sizeof(ts), ts, sizeof(uint64_t),
                                  VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT) == VK_SUCCESS && ts[1] >= ts[0])
            us.push_back((double)(ts[1] - ts[0]) * v.ts_period_ns / 1000.0);
    }
    double median = -1.0;
    if (!us.empty()) { std::sort(us.begin(), us.end()); median = us[us.size() / 2]; }
    vkDestroyCommandPool(v.device, cmdpool, nullptr); vkDestroyQueryPool(v.device, qpool, nullptr);
    vkDestroyDescriptorPool(v.device, dp, nullptr); vkDestroyPipeline(v.device, pipeline, nullptr);
    vkDestroyShaderModule(v.device, sm, nullptr); vkDestroyPipelineLayout(v.device, pll, nullptr);
    vkDestroyDescriptorSetLayout(v.device, dsl, nullptr);
    return median;
}

} // namespace

int main(int argc, char ** argv) {
    std::string spv_dir = "../vulkan";
    int runs = 5, warmup = 2;
    for (int i = 1; i < argc; i++) {
        if (!std::strcmp(argv[i], "--spv-dir") && i + 1 < argc) spv_dir = argv[++i];
        else if (!std::strcmp(argv[i], "--runs") && i + 1 < argc) runs = std::atoi(argv[++i]);
    }
    Vk v = init_vk();
    std::printf("[mul_mm_bench] device=%s ts_period=%.2fns runs=%d\n", v.device_name.c_str(), v.ts_period_ns, runs);
    auto spv_scalar = load_spirv(spv_dir + "/mul_mm_scalar.spv");
    auto spv_tiled  = load_spirv(spv_dir + "/mul_mm_tiled.spv");
    auto spv_reg    = load_spirv(spv_dir + "/mul_mm_reg.spv");

    struct Shape { uint32_t M, N, K; const char * tag; };
    Shape shapes[] = {
        { 512, 512, 512, "square-512" },
        { 1024, 1024, 1024, "square-1024" },
        { 256, 2048, 2048, "prefill-FFN (256x2048x2048)" },
        { 2048, 2048, 256, "proj (2048x2048x256)" },
    };
    int fails = 0;
    for (const Shape & s : shapes) {
        Buf A = alloc_buf(v, (VkDeviceSize)s.M * s.K * 4);
        Buf B = alloc_buf(v, (VkDeviceSize)s.K * s.N * 4);
        Buf C = alloc_buf(v, (VkDeviceSize)s.M * s.N * 4);
        float * Am = (float *)A.mapped, * Bm = (float *)B.mapped, * Cm = (float *)C.mapped;
        uint32_t seed = 0x1234u;
        auto rnd = [&]() { seed = seed * 1103515245u + 12345u; return ((seed >> 9) / 8388608.0f) - 1.0f; };
        for (uint64_t i = 0; i < (uint64_t)s.M * s.K; i++) Am[i] = rnd();
        for (uint64_t i = 0; i < (uint64_t)s.K * s.N; i++) Bm[i] = rnd();
        Push pc{ s.M, s.N, s.K };
        const double flop = 2.0 * s.M * s.N * s.K;
        const double tol = 1e-2 * s.K; // f32 accumulation tolerance scales with K

        // scalar baseline (16x16 grid) — the trusted reference output.
        double t_scalar = bench(v, spv_scalar, A, B, C, pc, (s.N + 15) / 16, (s.M + 15) / 16, warmup, runs);
        std::vector<float> Cscalar((size_t)s.M * s.N);
        std::memcpy(Cscalar.data(), Cm, Cscalar.size() * 4);
        // CPU spot-check anchors the scalar baseline on a few elements.
        double spot = 0.0;
        for (int t = 0; t < 8; t++) {
            uint32_t r = (uint32_t)((t * 131 + 7) % s.M), c = (uint32_t)((t * 197 + 11) % s.N);
            double acc = 0.0; for (uint32_t k = 0; k < s.K; k++) acc += (double)Am[(uint64_t)r * s.K + k] * (double)Bm[(uint64_t)k * s.N + c];
            spot = std::max(spot, std::fabs(acc - (double)Cscalar[(uint64_t)r * s.N + c]));
        }

        auto run_variant = [&](const std::vector<uint8_t> & spv, uint32_t gx, uint32_t gy) {
            std::memset(Cm, 0, (size_t)s.M * s.N * 4);
            double us = bench(v, spv, A, B, C, pc, gx, gy, warmup, runs);
            double md = 0.0;
            for (uint64_t i = 0; i < (uint64_t)s.M * s.N; i++) md = std::max(md, (double)std::fabs(Cm[i] - Cscalar[i]));
            return std::pair<double, double>(us, md);
        };
        auto [t_tiled, d_tiled] = run_variant(spv_tiled, (s.N + 15) / 16, (s.M + 15) / 16);
        auto [t_reg,   d_reg]   = run_variant(spv_reg,   (s.N + 63) / 64, (s.M + 63) / 64);

        bool ok = d_tiled < tol && d_reg < tol && spot < tol;
        if (!ok) fails++;
        std::printf("[%-26s] scalar=%8.1fus (%5.1f GF/s) | tiled=%8.1fus %.2fx | reg=%8.1fus %.2fx (%6.1f GF/s) | maxdiff tiled=%.2g reg=%.2g cpu=%.2g %s\n",
                    s.tag, t_scalar, flop / (t_scalar * 1e3),
                    t_tiled, t_scalar / t_tiled,
                    t_reg, t_scalar / t_reg, flop / (t_reg * 1e3),
                    d_tiled, d_reg, spot, ok ? "PASS" : "FAIL");
        free_buf(v, A); free_buf(v, B); free_buf(v, C);
    }
    std::printf("[mul_mm_bench] %s\n", fails == 0 ? "PASS — tiled matches scalar on all shapes" : "FAIL — correctness mismatch");
    return fails == 0 ? 0 : 1;
}
