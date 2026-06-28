// Composer 2.4 service entry for eliza_ai_soc.
//
// Status: compatibility wrapper. Uses the AOSP-provided default passthrough
// service that loads hwcomposer.eliza_ai_soc.so via hw_get_module().
// No GLES claim, no Vulkan claim.

#define LOG_TAG "hwc-eliza-service"

#include <android-base/logging.h>
#include <android/hardware/graphics/composer/2.4/IComposer.h>
#include <hidl/HidlTransportSupport.h>
#include <hidl/LegacySupport.h>

using ::android::OK;
using ::android::status_t;
using ::android::hardware::configureRpcThreadpool;
using ::android::hardware::defaultPassthroughServiceImplementation;
using ::android::hardware::graphics::composer::V2_4::IComposer;

int main() {
    configureRpcThreadpool(4, true /* willJoin */);
    status_t status = defaultPassthroughServiceImplementation<IComposer>();
    if (status != OK) {
        LOG(FATAL) << "Composer 2.4 passthrough failed: " << status;
    }
    return 0;
}
