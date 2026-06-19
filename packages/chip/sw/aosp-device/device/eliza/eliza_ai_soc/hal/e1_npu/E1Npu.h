// E1Npu.h - fixed-vector smoke implementation for vendor.eliza.e1_npu@1.0.
//
// Backing contract: sw/platform/e1_platform_contract.json
// Backing kernel node: /dev/e1-npu
//
// Fail-closed semantics:
//   - Constructor records whether /dev/e1-npu can be opened. It does
//     NOT keep the fd long-term; the smoke RPC re-opens on demand so a
//     kernel module reload is handled without state.
//   - All RPCs return Status::NOT_SUPPORTED when the device node is
//     missing. Any ioctl failure, contract mismatch, or math mismatch
//     returns IO_ERROR.

#pragma once

#include <sys/types.h>
#include <vendor/eliza/e1_npu/1.0/IE1Npu.h>

namespace vendor {
namespace eliza {
namespace e1_npu {
namespace V1_0 {
namespace implementation {

class E1Npu : public IE1Npu {
public:
    E1Npu();

    // IE1Npu
    ::android::hardware::Return<void> smoke(smoke_cb _hidl_cb) override;

private:
    // Path to the backing char device. Never cached as an fd.
    static constexpr const char* kDevicePath = "/dev/e1-npu";

    // Legacy identity/result offset kept tied to the platform contract so the
    // HAL cannot drift from the Linux driver ABI while smoke uses ioctls.
    static constexpr off_t kResultOffset = 0x08;
};

}  // namespace implementation
}  // namespace V1_0
}  // namespace e1_npu
}  // namespace eliza
}  // namespace vendor
