// hwcomposer.eliza_ai_soc - v0 framebuffer-only legacy module.
//
// Backing node: /dev/graphics/fb0 (Linux fbdev) or simple-framebuffer
// produced by CONFIG_FB_SIMPLE. No DRM/KMS, no GLES, no Vulkan, no HW
// overlays, no sideband, no VRR.
//
// This file intentionally implements only enough of the legacy hwcomposer
// HAL module entry points to load. Real composition is delegated to
// SurfaceFlinger's client composition path against the framebuffer.

#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <linux/fb.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <android-base/logging.h>
#include <hardware/hardware.h>
#include <hardware/hwcomposer2.h>

namespace {

constexpr const char* kFb0 = "/dev/graphics/fb0";

struct eliza_hwc_device {
    hwc2_device_t base;
    int fb_fd;
    struct fb_var_screeninfo vinfo;
    struct fb_fix_screeninfo finfo;
};

int eliza_hwc_close(hw_device_t* dev) {
    auto* d = reinterpret_cast<eliza_hwc_device*>(dev);
    if (d->fb_fd >= 0) ::close(d->fb_fd);
    std::free(d);
    return 0;
}

int eliza_hwc_open(const hw_module_t* module, const char* name,
                       hw_device_t** device) {
    if (std::strcmp(name, HWC_HARDWARE_COMPOSER) != 0) {
        LOG(ERROR) << "eliza_hwc: unknown sub-device: " << name;
        return -EINVAL;
    }

    auto* d = static_cast<eliza_hwc_device*>(
        std::calloc(1, sizeof(eliza_hwc_device)));
    if (!d) return -ENOMEM;

    d->base.common.tag = HARDWARE_DEVICE_TAG;
    d->base.common.version = HWC_DEVICE_API_VERSION_2_0;
    d->base.common.module = const_cast<hw_module_t*>(module);
    d->base.common.close = eliza_hwc_close;

    d->fb_fd = ::open(kFb0, O_RDWR | O_CLOEXEC);
    if (d->fb_fd < 0) {
        LOG(WARNING) << "eliza_hwc: framebuffer " << kFb0
                     << " unavailable (" << std::strerror(errno)
                     << ") - composer will report no displays";
    } else if (::ioctl(d->fb_fd, FBIOGET_VSCREENINFO, &d->vinfo) != 0 ||
               ::ioctl(d->fb_fd, FBIOGET_FSCREENINFO, &d->finfo) != 0) {
        LOG(ERROR) << "eliza_hwc: framebuffer ioctl probe failed: "
                   << std::strerror(errno);
        ::close(d->fb_fd);
        d->fb_fd = -1;
    } else {
        LOG(INFO) << "eliza_hwc: framebuffer " << d->vinfo.xres << "x"
                  << d->vinfo.yres << " bpp=" << d->vinfo.bits_per_pixel;
    }

    // No HWC2 function getters wired in v0; SurfaceFlinger falls back to
    // client composition against /dev/graphics/fb0 directly.
    d->base.getCapabilities = nullptr;
    d->base.getFunction = nullptr;

    *device = &d->base.common;
    return 0;
}

hw_module_methods_t eliza_hwc_module_methods = {
    .open = eliza_hwc_open,
};

}  // namespace

extern "C" hw_module_t HAL_MODULE_INFO_SYM = {
    .tag = HARDWARE_MODULE_TAG,
    .module_api_version = HWC_MODULE_API_VERSION_0_1,
    .hal_api_version = HARDWARE_HAL_API_VERSION,
    .id = HWC_HARDWARE_MODULE_ID,
    .name = "Eliza e1 hwcomposer (v0 framebuffer-only)",
    .author = "Eliza",
    .methods = &eliza_hwc_module_methods,
    .dso = nullptr,
    .reserved = {0},
};
