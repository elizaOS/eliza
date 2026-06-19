// E1NpuSim.h - Cuttlefish software-simulator implementation of
// vendor.eliza.e1_npu@1.0::IE1Npu for the vsoc_riscv64 target.
//
// Why this exists:
//   The real e1 NPU char device (/dev/e1-npu) does not exist under
//   Cuttlefish. To exercise the HAL surface end-to-end without silicon,
//   this implementation answers IE1Npu RPCs from a deterministic software
//   model. The AIDL/HIDL surface is identical to the on-device HAL so
//   VTS/lshal/checkvintf compat checks treat it as the same package.
//
// Contract bindings:
//   - Returns the same identity word the real driver returns on
//     /dev/e1-npu read at E1_NPU_RESULT_OFFSET (kSimulatedIdentity).
//     Source of truth: sw/platform/e1_platform_contract.json.
//   - Status::OK on every call; the sim never reports IO_ERROR or
//     NOT_SUPPORTED because no kernel node is required.
//   - Logs an explicit "simulator" provenance tag at construction time so
//     lshal/logcat consumers can distinguish sim vs real silicon.

#pragma once

#include <cstdint>
#include <vendor/eliza/e1_npu/1.0/IE1Npu.h>

namespace vendor {
namespace eliza {
namespace e1_npu {
namespace V1_0 {
namespace implementation {

class E1NpuSim : public IE1Npu {
public:
    E1NpuSim();

    // IE1Npu
    ::android::hardware::Return<void> smoke(smoke_cb _hidl_cb) override;

private:
    // Identity word matching the real driver's E1_NPU_RESULT_OFFSET read.
    // Kept in sync with sw/platform/e1_platform_contract.json and
    // sw/linux/drivers/e1/e1-npu.c (E1_NPU_IDENTITY).
    static constexpr uint32_t kSimulatedIdentity = 0xE11A0001u;
};

}  // namespace implementation
}  // namespace V1_0
}  // namespace e1_npu
}  // namespace eliza
}  // namespace vendor
