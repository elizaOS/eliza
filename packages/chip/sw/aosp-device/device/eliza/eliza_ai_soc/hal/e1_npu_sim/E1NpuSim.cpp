// E1NpuSim.cpp - Cuttlefish software-simulator IE1Npu implementation.
//
// Compute is a deterministic software stand-in. No DMA, no IOCTLs, no
// kernel node. The point is to exercise the binder/lshal/vintf surface
// end-to-end on vsoc_riscv64 without silicon.

#define LOG_TAG "vendor.eliza.e1_npu@1.0-service.sim"

#include "E1NpuSim.h"

#include <android-base/logging.h>

namespace vendor {
namespace eliza {
namespace e1_npu {
namespace V1_0 {
namespace implementation {

E1NpuSim::E1NpuSim() {
    LOG(INFO) << "e1_npu HAL (simulator) starting: compute=software, "
              << "identity=0x" << std::hex << kSimulatedIdentity;
}

::android::hardware::Return<void> E1NpuSim::smoke(smoke_cb _hidl_cb) {
    // The real HAL reads a 32-bit identity word from
    // E1_NPU_RESULT_OFFSET on /dev/e1-npu. Under Cuttlefish, the same
    // value is returned from a software constant so VTS and lshal smoke
    // tests can observe the contract identity.
    _hidl_cb(Status::OK, kSimulatedIdentity);
    return ::android::hardware::Void();
}

}  // namespace implementation
}  // namespace V1_0
}  // namespace e1_npu
}  // namespace eliza
}  // namespace vendor
