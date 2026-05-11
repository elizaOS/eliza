// Host-side Vulkan verification harness for the turbo3 / turbo4 / turbo3_tcq /
// qjl / polar compute shaders. Loads the JSON fixture written by gen_fixture,
// branches on the `kernel` field to choose the correct bind-set + push-constant
// shape, dispatches the shader, and compares scalar scores against the
// reference (default tolerance 1e-3 absolute).
//
// Build (only when VULKAN_SDK is set):
//     VULKAN_SDK=/opt/vulkan-sdk make vulkan
//
// Run:
//     ./vulkan_verify ../vulkan/turbo4.spv fixtures/turbo4.json
//     ./vulkan_verify ../vulkan/qjl.spv    fixtures/qjl.json
//     ./vulkan_verify ../vulkan/polar.spv  fixtures/polar.json
//
// The harness expects pre-compiled SPIR-V. To compile the shaders:
//     glslc --target-env=vulkan1.1 --target-spv=spv1.3 \
//           -fshader-stage=compute ../vulkan/<name>.comp -o ../vulkan/<name>.spv

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

static std::string lower_ascii(const char * s) {
    std::string out = s ? s : "";
    for (char & c : out) {
        if (c >= 'A' && c <= 'Z') c = (char) (c - 'A' + 'a');
    }
    return out;
}

static bool software_vulkan_allowed() {
    const char * value = std::getenv("ELIZA_ALLOW_SOFTWARE_VULKAN");
    return value && std::strcmp(value, "1") == 0;
}

static bool looks_like_software_vulkan_device(const char * name) {
    const std::string device = lower_ascii(name);
    return device.find("llvmpipe") != std::string::npos ||
           device.find("lavapipe") != std::string::npos ||
           device.find("swiftshader") != std::string::npos ||
           device.find("software rasterizer") != std::string::npos;
}

// --- Fixture: union of every kernel's input shape. Only fields relevant to
// the loaded fixture's `kernel` are populated; the rest stay default. ---
struct Fixture {
    std::string kernel;
    // turbo*: head_dim, n_kv, blocks_per_kv, q (n_head*head_dim), k_blocks
    // qjl:    head_dim=128, proj_dim=256, n_heads, n_kv_heads, n_tokens,
    //         q_sketch, k_blocks
    // polar:  head_dim=128 (== QK_POLAR), n_rows, use_qjl, q (head_dim),
    //         k_blocks
    int head_dim     = 0;
    int n_kv         = 0;   // turbo only
    int block_bytes  = 0;
    int blocks_per_kv= 0;   // turbo only
    int proj_dim     = 0;   // qjl only
    int n_heads      = 0;   // qjl only
    int n_kv_heads   = 0;   // qjl only
    int n_tokens     = 0;   // qjl only
    int n_rows       = 0;   // polar only
    int use_qjl      = 0;   // polar only
    std::vector<float>   q;          // turbo / polar
    std::vector<float>   q_sketch;   // qjl
    std::vector<uint8_t> k_blocks;
    std::vector<float>   expected_scores;
};

static std::string slurp(const char * path) {
    std::ifstream f(path);
    if (!f) { std::fprintf(stderr, "cannot open %s\n", path); std::exit(1); }
    std::stringstream ss; ss << f.rdbuf(); return ss.str();
}

static bool find_key(const std::string & s, const char * key, size_t & pos) {
    std::string needle = std::string("\"") + key + "\"";
    size_t k = s.find(needle);
    if (k == std::string::npos) return false;
    size_t colon = s.find(':', k);
    pos = colon + 1;
    while (pos < s.size() && std::isspace((unsigned char)s[pos])) pos++;
    return true;
}

static int parse_int_after(const std::string & s, size_t pos) {
    while (pos < s.size() && std::isspace((unsigned char)s[pos])) pos++;
    char * end = nullptr;
    long v = std::strtol(s.c_str() + pos, &end, 10);
    return (int)v;
}

static std::vector<float> parse_float_array_at(const std::string & s, size_t pos) {
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
    return out;
}

static std::vector<uint8_t> parse_byte_array_at(const std::string & s, size_t pos) {
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
    return out;
}

static std::string parse_string_at(const std::string & s, size_t pos) {
    while (s[pos] != '"') pos++;
    pos++;
    size_t start = pos;
    while (s[pos] != '"') pos++;
    return s.substr(start, pos - start);
}

static int get_int(const std::string & s, const char * key, int dflt = 0) {
    size_t pos = 0;
    if (!find_key(s, key, pos)) return dflt;
    return parse_int_after(s, pos);
}

static std::vector<float> get_floats(const std::string & s, const char * key) {
    size_t pos = 0;
    if (!find_key(s, key, pos)) return {};
    return parse_float_array_at(s, pos);
}

static std::vector<uint8_t> get_bytes(const std::string & s, const char * key) {
    size_t pos = 0;
    if (!find_key(s, key, pos)) return {};
    return parse_byte_array_at(s, pos);
}

static Fixture load_fixture(const char * path) {
    std::string s = slurp(path);
    Fixture fx;
    {
        size_t pos = 0;
        if (!find_key(s, "kernel", pos)) {
            std::fprintf(stderr, "fixture missing 'kernel' field\n"); std::exit(1);
        }
        fx.kernel = parse_string_at(s, pos);
    }
    fx.head_dim        = get_int(s, "head_dim");
    fx.n_kv            = get_int(s, "n_kv");
    fx.block_bytes     = get_int(s, "block_bytes");
    fx.blocks_per_kv   = get_int(s, "blocks_per_kv");
    fx.proj_dim        = get_int(s, "proj_dim");
    fx.n_heads         = get_int(s, "n_heads");
    fx.n_kv_heads      = get_int(s, "n_kv_heads");
    fx.n_tokens        = get_int(s, "n_tokens");
    fx.n_rows          = get_int(s, "n_rows");
    fx.use_qjl         = get_int(s, "use_qjl");
    fx.q               = get_floats(s, "q");
    fx.q_sketch        = get_floats(s, "q_sketch");
    fx.k_blocks        = get_bytes(s, "k_blocks");
    fx.expected_scores = get_floats(s, "expected_scores");
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

static void hadamard128_inplace(std::vector<float> & x) {
    if (x.size() != 128) {
        std::fprintf(stderr, "hadamard128_inplace: expected 128 floats, got %zu\n", x.size());
        std::exit(2);
    }
    for (size_t h = 1; h < x.size(); h <<= 1) {
        for (size_t i = 0; i < x.size(); i += h << 1) {
            for (size_t j = i; j < i + h; ++j) {
                const float a = x[j];
                const float b = x[j + h];
                x[j]     = a + b;
                x[j + h] = a - b;
            }
        }
    }
}

// --- Push-constant structs. One per kernel family. Strong typing only — no
// catch-all union — so a mismatch between fixture and shader is a compile
// error in the harness, not a silent garbage push.
struct TurboPush {
    uint32_t head_dim;
    uint32_t n_kv;
    uint32_t kv_stride_blocks;
    uint32_t q_head;
    uint32_t head_offset_bytes;
};

struct QjlPush {
    uint32_t n_heads;
    uint32_t n_kv_heads;
    uint32_t n_tokens;
    uint32_t proj_dim;
};

struct PolarPush {
    uint32_t n_rows;
    uint32_t head_dim;
    uint32_t use_qjl;
    uint32_t k_offset_bytes;
    uint32_t q_offset;
    uint32_t y_offset;
};

// --- Kernel-specific dispatch parameters resolved from the fixture. ---
struct KernelBindings {
    // Storage buffer #i payload: pointer + byte size. Bound at descriptor slot i.
    struct Slot { const void * data; size_t bytes; };
    std::vector<Slot> inputs;        // bindings 0..N-1
    size_t            output_bytes;  // last binding is the writeonly output
    uint32_t          n_outputs;     // number of fp32 scalars expected
    uint32_t          dispatch_x;
    uint32_t          dispatch_y;
    uint32_t          dispatch_z;
    // Push constants serialized to bytes for vkCmdPushConstants.
    std::vector<uint8_t> push_bytes;
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
    const bool kernel_uses_preht = std::strstr(spv_path, "preht") != nullptr;

    Fixture fx = load_fixture(fx_path);
    std::printf("[vulkan_verify] kernel=%s\n", fx.kernel.c_str());

    // --- Resolve kernel-specific bind-set, push constants, dispatch shape ---
    KernelBindings kb{};
    std::vector<float> polar_q_storage;
    if (fx.kernel == "turbo3" || fx.kernel == "turbo4" || fx.kernel == "turbo3_tcq") {
        // 3 buffers (q, k_blocks, scores) + optional codebook for turbo3_tcq.
        kb.inputs.push_back({ fx.q.data(),         fx.q.size() * sizeof(float) });
        kb.inputs.push_back({ fx.k_blocks.data(),  fx.k_blocks.size() });
        kb.output_bytes = (size_t)fx.n_kv * sizeof(float);
        kb.n_outputs    = (uint32_t)fx.n_kv;
        kb.dispatch_x   = (uint32_t)fx.n_kv;
        kb.dispatch_y   = 1;
        kb.dispatch_z   = 1;

        TurboPush pc{};
        pc.head_dim          = (uint32_t)fx.head_dim;
        pc.n_kv              = (uint32_t)fx.n_kv;
        pc.kv_stride_blocks  = (uint32_t)fx.blocks_per_kv;
        pc.q_head            = 0;
        pc.head_offset_bytes = 0;
        kb.push_bytes.assign((const uint8_t *)&pc,
                             (const uint8_t *)&pc + sizeof(pc));
    } else if (fx.kernel == "qjl") {
        // bindings = q_sketch (fp32) + packed_k (34B-block stream) + scores (fp32)
        if (fx.proj_dim != 256) {
            std::fprintf(stderr, "qjl: proj_dim must be 256 (got %d)\n", fx.proj_dim);
            return 1;
        }
        kb.inputs.push_back({ fx.q_sketch.data(), fx.q_sketch.size() * sizeof(float) });
        kb.inputs.push_back({ fx.k_blocks.data(), fx.k_blocks.size() });
        kb.output_bytes = (size_t)fx.n_heads * (size_t)fx.n_tokens * sizeof(float);
        kb.n_outputs    = (uint32_t)(fx.n_heads * fx.n_tokens);
        kb.dispatch_x   = (uint32_t)fx.n_heads;
        kb.dispatch_y   = (uint32_t)fx.n_tokens;
        kb.dispatch_z   = 1;

        QjlPush pc{};
        pc.n_heads    = (uint32_t)fx.n_heads;
        pc.n_kv_heads = (uint32_t)fx.n_kv_heads;
        pc.n_tokens   = (uint32_t)fx.n_tokens;
        pc.proj_dim   = (uint32_t)fx.proj_dim;
        kb.push_bytes.assign((const uint8_t *)&pc,
                             (const uint8_t *)&pc + sizeof(pc));
    } else if (fx.kernel == "polar") {
        // bindings = k_blocks (82B-block stream) + q (fp32) + y (fp32)
        if (fx.head_dim != 128) {
            std::fprintf(stderr, "polar: head_dim must be 128 (got %d)\n", fx.head_dim);
            return 1;
        }
        const float * q_data = fx.q.data();
        if (kernel_uses_preht) {
            polar_q_storage = fx.q;
            hadamard128_inplace(polar_q_storage);
            q_data = polar_q_storage.data();
            std::printf("[vulkan_verify] polar pre-Hadamard query enabled by SPIR-V path\n");
        }
        kb.inputs.push_back({ fx.k_blocks.data(), fx.k_blocks.size() });
        kb.inputs.push_back({ q_data,              fx.q.size() * sizeof(float) });
        kb.output_bytes = (size_t)fx.n_rows * sizeof(float);
        kb.n_outputs    = (uint32_t)fx.n_rows;
        kb.dispatch_x   = (uint32_t)fx.n_rows;
        kb.dispatch_y   = 1;
        kb.dispatch_z   = 1;

        PolarPush pc{};
        pc.n_rows   = (uint32_t)fx.n_rows;
        pc.head_dim = (uint32_t)fx.head_dim;
        pc.use_qjl  = (uint32_t)fx.use_qjl;
        pc.k_offset_bytes = 0;
        pc.q_offset = 0;
        pc.y_offset = 0;
        kb.push_bytes.assign((const uint8_t *)&pc,
                             (const uint8_t *)&pc + sizeof(pc));
    } else {
        std::fprintf(stderr, "unknown kernel '%s' in fixture\n", fx.kernel.c_str());
        return 1;
    }
    if (fx.expected_scores.size() != kb.n_outputs) {
        std::fprintf(stderr,
                     "fixture expected_scores length mismatch: got %zu, need %u\n",
                     fx.expected_scores.size(), kb.n_outputs);
        return 2;
    }

    // --- Vulkan instance ---
    VkApplicationInfo ai{};
    ai.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
    ai.pApplicationName = "eliza-kv-verify";
    ai.apiVersion = VK_API_VERSION_1_2;
    VkInstanceCreateInfo ici{};
    ici.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
    ici.pApplicationInfo = &ai;
    // MoltenVK on macOS is a non-conformant ICD and the Vulkan loader requires
    // VK_KHR_portability_enumeration + the ENUMERATE_PORTABILITY flag to be
    // willing to enumerate it. Always-on here is safe — the extension is
    // either present (macOS) or absent (Linux/Windows desktop ICDs are fully
    // conformant) but harmless if the loader supports it.
    const char * inst_exts[] = { "VK_KHR_portability_enumeration" };
    ici.enabledExtensionCount   = 1;
    ici.ppEnabledExtensionNames = inst_exts;
    ici.flags                   = 0x00000001; // VK_INSTANCE_CREATE_ENUMERATE_PORTABILITY_BIT_KHR
    VkInstance instance;
    if (vkCreateInstance(&ici, nullptr, &instance) != VK_SUCCESS) {
        // Fallback for loaders without the portability extension (Linux, Windows).
        ici.enabledExtensionCount = 0;
        ici.ppEnabledExtensionNames = nullptr;
        ici.flags = 0;
        VK_CHECK(vkCreateInstance(&ici, nullptr, &instance));
    }

    // --- Pick first physical device with a compute queue ---
    uint32_t pd_count = 0;
    VK_CHECK(vkEnumeratePhysicalDevices(instance, &pd_count, nullptr));
    if (pd_count == 0) { std::fprintf(stderr, "no Vulkan devices\n"); return 1; }
    std::vector<VkPhysicalDevice> pds(pd_count);
    VK_CHECK(vkEnumeratePhysicalDevices(instance, &pd_count, pds.data()));
    VkPhysicalDevice pd = VK_NULL_HANDLE;
    uint32_t qfam = (uint32_t)-1;
    for (VkPhysicalDevice cand : pds) {
        uint32_t cand_qfam_count = 0;
        vkGetPhysicalDeviceQueueFamilyProperties(cand, &cand_qfam_count, nullptr);
        std::vector<VkQueueFamilyProperties> cand_qfams(cand_qfam_count);
        vkGetPhysicalDeviceQueueFamilyProperties(cand, &cand_qfam_count, cand_qfams.data());
        for (uint32_t i = 0; i < cand_qfam_count; i++) {
            if (cand_qfams[i].queueFlags & VK_QUEUE_COMPUTE_BIT) {
                pd = cand;
                qfam = i;
                break;
            }
        }
        if (pd != VK_NULL_HANDLE) break;
    }
    if (pd == VK_NULL_HANDLE) { std::fprintf(stderr, "no compute-capable Vulkan device\n"); return 1; }
    {
        VkPhysicalDeviceProperties props;
        vkGetPhysicalDeviceProperties(pd, &props);
        std::printf("[vulkan_verify] device=%s api=%u.%u.%u\n", props.deviceName,
                    VK_VERSION_MAJOR(props.apiVersion),
                    VK_VERSION_MINOR(props.apiVersion),
                    VK_VERSION_PATCH(props.apiVersion));
        if (!software_vulkan_allowed() &&
                looks_like_software_vulkan_device(props.deviceName)) {
            std::fprintf(stderr,
                "[vulkan_verify] refusing software Vulkan device '%s'. "
                "Set ELIZA_ALLOW_SOFTWARE_VULKAN=1 for diagnostics only.\n",
                props.deviceName);
            return 2;
        }
    }

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
    // VK_KHR_portability_subset is a required device extension on MoltenVK.
    // Probe and enable it if available; conformant ICDs ignore the request.
    uint32_t dev_ext_count = 0;
    vkEnumerateDeviceExtensionProperties(pd, nullptr, &dev_ext_count, nullptr);
    std::vector<VkExtensionProperties> dev_exts(dev_ext_count);
    vkEnumerateDeviceExtensionProperties(pd, nullptr, &dev_ext_count, dev_exts.data());
    std::vector<const char *> enabled_dev_exts;
    for (auto & e : dev_exts) {
        if (std::strcmp(e.extensionName, "VK_KHR_portability_subset") == 0) {
            enabled_dev_exts.push_back("VK_KHR_portability_subset");
        }
    }
    dci.enabledExtensionCount   = (uint32_t)enabled_dev_exts.size();
    dci.ppEnabledExtensionNames = enabled_dev_exts.empty() ? nullptr : enabled_dev_exts.data();
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
        // Vulkan buffers must have nonzero size; round zero-byte payloads up.
        b.size = bytes == 0 ? 4 : bytes;
        VkBufferCreateInfo bi{};
        bi.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
        bi.size = b.size; bi.usage = usage;
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
        VK_CHECK(vkMapMemory(device, b.mem, 0, b.size, 0, &b.mapped));
        return b;
    };

    // --- Allocate input buffers + the output buffer + optional codebook ---
    bool needs_codebook = (fx.kernel == "turbo3_tcq");
    uint32_t n_inputs = (uint32_t)kb.inputs.size();
    uint32_t n_bindings = n_inputs + 1 + (needs_codebook ? 1 : 0);

    std::vector<Buf> in_bufs(n_inputs);
    for (uint32_t i = 0; i < n_inputs; i++) {
        in_bufs[i] = alloc_buf((VkDeviceSize)kb.inputs[i].bytes,
                               VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
        if (kb.inputs[i].bytes > 0) {
            std::memcpy(in_bufs[i].mapped, kb.inputs[i].data, kb.inputs[i].bytes);
        }
    }
    Buf out_buf = alloc_buf((VkDeviceSize)kb.output_bytes,
                            VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    std::memset(out_buf.mapped, 0, out_buf.size);

    Buf cb_buf{};
    if (needs_codebook) {
        cb_buf = alloc_buf(512 * sizeof(float), VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
        std::memcpy(cb_buf.mapped, ELIZA_TURBO3_TCQ_CODEBOOK, 512 * sizeof(float));
    }

    // --- Descriptor set layout / pool / set ---
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
    for (uint32_t i = 0; i < n_inputs; i++) {
        bi[i] = { in_bufs[i].buf, 0, VK_WHOLE_SIZE };
    }
    bi[n_inputs] = { out_buf.buf, 0, VK_WHOLE_SIZE };
    if (needs_codebook) bi[n_inputs + 1] = { cb_buf.buf, 0, VK_WHOLE_SIZE };
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
    pcr.size = (uint32_t)kb.push_bytes.size();
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
    vkCmdPushConstants(cb, pll, VK_SHADER_STAGE_COMPUTE_BIT, 0,
                       (uint32_t)kb.push_bytes.size(), kb.push_bytes.data());
    vkCmdDispatch(cb, kb.dispatch_x, kb.dispatch_y, kb.dispatch_z);
    VK_CHECK(vkEndCommandBuffer(cb));

    VkSubmitInfo si{};
    si.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    si.commandBufferCount = 1; si.pCommandBuffers = &cb;
    VK_CHECK(vkQueueSubmit(queue, 1, &si, VK_NULL_HANDLE));
    VK_CHECK(vkQueueWaitIdle(queue));

    // --- Compare ---
    const float * out = (const float *)out_buf.mapped;
    int failures = 0;
    int compare_n = (int)kb.n_outputs;
    float max_diff = 0.0f;
    for (int i = 0; i < compare_n; i++) {
        float diff = std::fabs(out[i] - fx.expected_scores[i]);
        if (diff > max_diff) max_diff = diff;
        const char * tag = (diff < tol) ? "PASS" : "FAIL";
        std::printf("  i=%d expected=%+.6f got=%+.6f diff=%.3e %s\n",
                    i, (double)fx.expected_scores[i], (double)out[i], (double)diff, tag);
        if (diff >= tol) failures++;
    }

    std::printf("[vulkan_verify] %s — %d/%d passed (tol=%.0e, max_diff=%.3e)\n",
                failures == 0 ? "PASS" : "FAIL",
                compare_n - failures, compare_n, (double)tol, (double)max_diff);
    return failures == 0 ? 0 : 1;
}
