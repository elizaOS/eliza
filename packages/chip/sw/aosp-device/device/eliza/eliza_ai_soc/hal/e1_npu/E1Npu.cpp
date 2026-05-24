// E1Npu.cpp - fixed-vector smoke implementation.
//
// Fail-closed: if /dev/e1-npu cannot be opened, every RPC returns
// Status::NOT_SUPPORTED. The RPC returns OK only after the kernel driver
// accepts the platform contract and deterministic RELU/GEMM ioctl workload.

#define LOG_TAG "vendor.eliza.e1_npu@1.0-service"

#include "E1Npu.h"
#include "E1NpuUapi.h"

#include <cerrno>
#include <cstddef>
#include <cstring>
#include <fcntl.h>
#include <iomanip>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <android-base/logging.h>
#include <android-base/unique_fd.h>

namespace vendor {
namespace eliza {
namespace e1_npu {
namespace V1_0 {
namespace implementation {

using ::android::base::unique_fd;

namespace {

constexpr uint32_t kExpectedNpuBase = 0x10020000u;
constexpr uint32_t kExpectedReluResult = 0x00070000u;
constexpr int32_t kExpectedGemm[4] = {-44, 8, 139, -54};

void fillGemm(e1_npu_gemm_s8* gemm) {
    std::memset(gemm, 0, sizeof(*gemm));
    gemm->m = 2;
    gemm->n = 2;
    gemm->k = 3;
    gemm->a[0] = 1;
    gemm->a[1] = -2;
    gemm->a[2] = 3;
    gemm->a[3] = 4;
    gemm->a[4] = 5;
    gemm->a[5] = -6;
    gemm->b[0] = 7;
    gemm->b[1] = -8;
    gemm->b[2] = 9;
    gemm->b[3] = 10;
    gemm->b[4] = -11;
    gemm->b[5] = 12;
}

bool gemmMatches(const e1_npu_gemm_s8& gemm) {
    for (size_t i = 0; i < 4; ++i) {
        if (gemm.c[i] != kExpectedGemm[i]) {
            LOG(ERROR) << "GEMM_S8 mismatch at C[" << i << "]: got="
                       << gemm.c[i] << " expected=" << kExpectedGemm[i];
            return false;
        }
    }
    return true;
}

}  // namespace

E1Npu::E1Npu() {
    struct stat st;
    if (::stat(kDevicePath, &st) != 0) {
        LOG(WARNING) << "e1_npu HAL starting without backing device "
                     << kDevicePath
                     << " (fail-closed: smoke() will return NOT_SUPPORTED)";
    } else {
        LOG(INFO) << "e1_npu HAL backing device present: " << kDevicePath;
    }
}

::android::hardware::Return<void> E1Npu::smoke(smoke_cb _hidl_cb) {
    unique_fd fd(::open(kDevicePath, O_RDWR | O_CLOEXEC));
    if (fd.get() < 0) {
        LOG(WARNING) << "open(" << kDevicePath
                     << ") failed: " << std::strerror(errno);
        _hidl_cb(Status::NOT_SUPPORTED, 0);
        return ::android::hardware::Void();
    }

    e1_npu_contract contract = {};
    if (::ioctl(fd.get(), E1_NPU_IOC_GET_CONTRACT, &contract) < 0) {
        LOG(ERROR) << "E1_NPU_IOC_GET_CONTRACT failed: "
                   << std::strerror(errno);
        _hidl_cb(Status::IO_ERROR, 0);
        return ::android::hardware::Void();
    }
    if (contract.version != 1 || contract.npu_base != kExpectedNpuBase ||
        contract.scratch_bytes != E1_NPU_SCRATCH_BYTES) {
        LOG(ERROR) << "unexpected NPU contract: version=" << contract.version
                   << " base=0x" << std::hex << contract.npu_base
                   << " scratch=" << std::dec << contract.scratch_bytes;
        _hidl_cb(Status::IO_ERROR, 0);
        return ::android::hardware::Void();
    }

    e1_npu_cmd relu = {};
    relu.opcode = E1_NPU_OP_RELU4_S8;
    relu.a = 0x800700fcu;
    if (::ioctl(fd.get(), E1_NPU_IOC_RUN_CMD, &relu) < 0) {
        LOG(ERROR) << "E1_NPU_IOC_RUN_CMD RELU4_S8 failed: "
                   << std::strerror(errno);
        _hidl_cb(Status::IO_ERROR, 0);
        return ::android::hardware::Void();
    }
    if (relu.result != kExpectedReluResult) {
        LOG(ERROR) << "RELU4_S8 mismatch: got=0x" << std::hex << relu.result
                   << " expected=0x" << kExpectedReluResult;
        _hidl_cb(Status::IO_ERROR, 0);
        return ::android::hardware::Void();
    }

    e1_npu_gemm_s8 gemm = {};
    fillGemm(&gemm);
    if (::ioctl(fd.get(), E1_NPU_IOC_RUN_GEMM_S8, &gemm) < 0) {
        LOG(ERROR) << "E1_NPU_IOC_RUN_GEMM_S8 failed: "
                   << std::strerror(errno);
        _hidl_cb(Status::IO_ERROR, 0);
        return ::android::hardware::Void();
    }
    if (!gemmMatches(gemm)) {
        _hidl_cb(Status::IO_ERROR, 0);
        return ::android::hardware::Void();
    }

    _hidl_cb(Status::OK, contract.npu_base);
    return ::android::hardware::Void();
}

}  // namespace implementation
}  // namespace V1_0
}  // namespace e1_npu
}  // namespace eliza
}  // namespace vendor
