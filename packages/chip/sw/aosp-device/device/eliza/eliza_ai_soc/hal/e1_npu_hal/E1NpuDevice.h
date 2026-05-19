// E1NpuDevice.h — HIDL 1.3 IDevice implementation for the e1 NPU.
//
// Register layout source of truth:
//   sw/platform/e1_platform_contract.json  (npu region, base 0x10020000)
// Opcode table source of truth:
//   docs/arch/npu.md

#pragma once

#include <android/hardware/neuralnetworks/1.3/IDevice.h>
#include <android/hardware/neuralnetworks/1.3/types.h>
#include <hidl/MQDescriptor.h>
#include <hidl/Status.h>

namespace android {
namespace hardware {
namespace neuralnetworks {
namespace V1_3 {
namespace e1_npu {

using ::android::hardware::neuralnetworks::V1_0::DeviceStatus;
using ::android::hardware::neuralnetworks::V1_0::ErrorStatus;
using ::android::hardware::neuralnetworks::V1_0::RequestArgument;
using ::android::hardware::neuralnetworks::V1_2::DeviceType;
using ::android::hardware::neuralnetworks::V1_2::Extension;
using ::android::hardware::neuralnetworks::V1_3::BufferDesc;
using ::android::hardware::neuralnetworks::V1_3::BufferRole;
using ::android::hardware::neuralnetworks::V1_3::IBuffer;
using ::android::hardware::neuralnetworks::V1_3::IDevice;
using ::android::hardware::neuralnetworks::V1_3::IPreparedModelCallback;
using ::android::hardware::neuralnetworks::V1_3::Model;
using ::android::hardware::neuralnetworks::V1_3::OptionalTimePoint;
using ::android::hardware::neuralnetworks::V1_3::Subgraph;
using ::android::hardware::Return;
using ::android::hardware::Void;
using ::android::hardware::hidl_string;
using ::android::hardware::hidl_vec;
using ::android::sp;

// Set of NNAPI operation types dispatched to the e1 NPU hardware path.
// All others fall back to CPU execution. Sourced from docs/arch/npu.md:
// the NPU implements ADD, MUL_LO, MAC_S16, DOT4_S8, MAX_U32, MIN_U32, GEMM_S8.
// The NNAPI operations listed here map onto those primitives.
static constexpr V1_3::OperationType kNpuSupportedOps[] = {
    V1_3::OperationType::ADD,
    V1_3::OperationType::MUL,
    V1_3::OperationType::RELU,
    V1_3::OperationType::RELU6,
    V1_3::OperationType::CONV_2D,
    V1_3::OperationType::DEPTHWISE_CONV_2D,
    V1_3::OperationType::MAX_POOL_2D,
    V1_3::OperationType::AVERAGE_POOL_2D,
    V1_3::OperationType::FULLY_CONNECTED,
    V1_3::OperationType::RESHAPE,
    V1_3::OperationType::SOFTMAX,
};

class E1NpuDevice : public IDevice {
public:
    E1NpuDevice() = default;
    ~E1NpuDevice() override = default;

    // IDevice 1.0
    Return<ErrorStatus> prepareModel(
        const ::android::hardware::neuralnetworks::V1_0::Model& model,
        const sp<::android::hardware::neuralnetworks::V1_0::IPreparedModelCallback>& callback) override;

    Return<DeviceStatus> getStatus() override;

    // IDevice 1.1
    Return<ErrorStatus> prepareModel_1_1(
        const ::android::hardware::neuralnetworks::V1_1::Model& model,
        ::android::hardware::neuralnetworks::V1_1::ExecutionPreference preference,
        const sp<::android::hardware::neuralnetworks::V1_0::IPreparedModelCallback>& callback) override;

    // IDevice 1.2
    Return<void> getVersionString(getVersionString_cb _hidl_cb) override;
    Return<void> getType(getType_cb _hidl_cb) override;
    Return<void> getSupportedExtensions(getSupportedExtensions_cb _hidl_cb) override;
    Return<void> getCapabilities_1_2(getCapabilities_1_2_cb _hidl_cb) override;
    Return<void> getSupportedOperations_1_2(
        const ::android::hardware::neuralnetworks::V1_2::Model& model,
        getSupportedOperations_1_2_cb _hidl_cb) override;
    Return<ErrorStatus> prepareModel_1_2(
        const ::android::hardware::neuralnetworks::V1_2::Model& model,
        ::android::hardware::neuralnetworks::V1_1::ExecutionPreference preference,
        const hidl_vec<hidl_handle>& modelCache,
        const hidl_vec<hidl_handle>& dataCache,
        const ::android::hardware::hidl_array<uint8_t, 32>& token,
        const sp<::android::hardware::neuralnetworks::V1_2::IPreparedModelCallback>& callback) override;
    Return<ErrorStatus> prepareModelFromCache(
        const hidl_vec<hidl_handle>& modelCache,
        const hidl_vec<hidl_handle>& dataCache,
        const ::android::hardware::hidl_array<uint8_t, 32>& token,
        const sp<::android::hardware::neuralnetworks::V1_2::IPreparedModelCallback>& callback) override;
    Return<void> getNumberOfCacheFilesNeeded(getNumberOfCacheFilesNeeded_cb _hidl_cb) override;

    // IDevice 1.3
    Return<void> getCapabilities_1_3(getCapabilities_1_3_cb _hidl_cb) override;
    Return<void> getSupportedOperations_1_3(
        const Model& model,
        getSupportedOperations_1_3_cb _hidl_cb) override;
    Return<ErrorStatus> prepareModel_1_3(
        const Model& model,
        ::android::hardware::neuralnetworks::V1_1::ExecutionPreference preference,
        ::android::hardware::neuralnetworks::V1_3::Priority priority,
        const OptionalTimePoint& deadline,
        const hidl_vec<hidl_handle>& modelCache,
        const hidl_vec<hidl_handle>& dataCache,
        const ::android::hardware::hidl_array<uint8_t, 32>& token,
        const sp<IPreparedModelCallback>& callback) override;
    Return<ErrorStatus> prepareModelFromCache_1_3(
        const OptionalTimePoint& deadline,
        const hidl_vec<hidl_handle>& modelCache,
        const hidl_vec<hidl_handle>& dataCache,
        const ::android::hardware::hidl_array<uint8_t, 32>& token,
        const sp<IPreparedModelCallback>& callback) override;
    Return<void> allocate(
        const BufferDesc& desc,
        const hidl_vec<BufferRole>& inputRoles,
        const hidl_vec<BufferRole>& outputRoles,
        allocate_cb _hidl_cb) override;

private:
    // Returns true if the given operation type is handled by the NPU hw path.
    static bool isNpuOp(V1_3::OperationType type);

    // Fills in the PerformanceInfo for INT8 quantized operations.
    // Throughput estimate: 100 TOPS at ~1 TOPS/op-unit → 100 relative units.
    // Power estimate: 500 mW, 100 TOPS → 0.005 mW per op, normalized.
    static ::android::hardware::neuralnetworks::V1_0::PerformanceInfo int8Perf();
    static ::android::hardware::neuralnetworks::V1_0::PerformanceInfo floatPerf();
};

} // namespace e1_npu
} // namespace V1_3
} // namespace neuralnetworks
} // namespace hardware
} // namespace android
