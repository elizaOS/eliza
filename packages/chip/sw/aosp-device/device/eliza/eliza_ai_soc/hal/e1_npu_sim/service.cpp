// service.cpp - HwBinder service entry point for the Cuttlefish
// software-simulator IE1Npu implementation.
//
// Registers vendor.eliza.e1_npu@1.0::IE1Npu/default like the real HAL,
// so lshal/checkvintf can't tell them apart at the binder interface
// level. Logcat tag and INFO line at construction time make the
// "simulator" provenance explicit.

#define LOG_TAG "vendor.eliza.e1_npu@1.0-service.sim"

#include <android-base/logging.h>
#include <hidl/HidlTransportSupport.h>

#include "E1NpuSim.h"

using ::android::OK;
using ::android::sp;
using ::android::status_t;
using ::android::hardware::configureRpcThreadpool;
using ::android::hardware::joinRpcThreadpool;
using ::vendor::eliza::e1_npu::V1_0::IE1Npu;
using ::vendor::eliza::e1_npu::V1_0::implementation::E1NpuSim;

int main() {
    configureRpcThreadpool(1, true /* willJoin */);

    sp<IE1Npu> service = new E1NpuSim();
    status_t status = service->registerAsService();
    if (status != OK) {
        LOG(FATAL) << "Failed to register IE1Npu/default (sim): " << status;
        return 1;
    }

    LOG(INFO) << "vendor.eliza.e1_npu@1.0-service.sim registered "
              << "(Cuttlefish software-simulator path)";
    joinRpcThreadpool();
    return 0;  // not reached
}
