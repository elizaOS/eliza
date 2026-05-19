// E1Npu.cpp - v0 stub implementation.
//
// Fail-closed: if /dev/e1-npu cannot be opened, every RPC returns
// Status::NOT_SUPPORTED. No fake data is ever returned to the caller.

#define LOG_TAG "vendor.eliza.e1_npu@1.0-service"

#include "E1Npu.h"

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <android-base/logging.h>
#include <android-base/unique_fd.h>

namespace vendor {
namespace eliza {
namespace e1_npu {
namespace V1_0 {
namespace implementation {

using ::android::base::unique_fd;

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

    if (::lseek(fd.get(), kResultOffset, SEEK_SET) == (off_t)-1) {
        LOG(ERROR) << "lseek to result offset failed: "
                   << std::strerror(errno);
        _hidl_cb(Status::IO_ERROR, 0);
        return ::android::hardware::Void();
    }

    uint32_t identity = 0;
    ssize_t n = ::read(fd.get(), &identity, sizeof(identity));
    if (n != static_cast<ssize_t>(sizeof(identity))) {
        LOG(ERROR) << "short/failed read at result offset: n=" << n
                   << " errno=" << std::strerror(errno);
        _hidl_cb(Status::IO_ERROR, 0);
        return ::android::hardware::Void();
    }

    _hidl_cb(Status::OK, identity);
    return ::android::hardware::Void();
}

}  // namespace implementation
}  // namespace V1_0
}  // namespace e1_npu
}  // namespace eliza
}  // namespace vendor
