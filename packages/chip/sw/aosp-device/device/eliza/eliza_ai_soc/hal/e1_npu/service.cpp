// service.cpp - HwBinder service entry point for vendor.eliza.e1_npu@1.0.
//
// Single-threaded passthrough is sufficient for the v0 fixed-vector smoke
// RPC. Bumping the thread pool can wait for real workload evidence.

#define LOG_TAG "vendor.eliza.e1_npu@1.0-service"

#include <android-base/logging.h>
#include <hidl/HidlTransportSupport.h>

#include "E1Npu.h"

using ::android::OK;
using ::android::sp;
using ::android::status_t;
using ::android::hardware::configureRpcThreadpool;
using ::android::hardware::joinRpcThreadpool;
using ::vendor::eliza::e1_npu::V1_0::IE1Npu;
using ::vendor::eliza::e1_npu::V1_0::implementation::E1Npu;

int main() {
    configureRpcThreadpool(1, true /* willJoin */);

    sp<IE1Npu> service = new E1Npu();
    status_t status = service->registerAsService();
    if (status != OK) {
        LOG(FATAL) << "Failed to register IE1Npu/default: " << status;
        return 1;
    }

    LOG(INFO) << "vendor.eliza.e1_npu@1.0-service registered";
    joinRpcThreadpool();
    return 0;  // not reached
}
