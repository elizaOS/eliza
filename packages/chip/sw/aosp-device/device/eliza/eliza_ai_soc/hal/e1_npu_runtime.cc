// SPDX-License-Identifier: Apache-2.0
/*
 * Host-buildable runtime skeleton for the future e1_npu.default HAL.
 *
 * This file intentionally has no Android framework dependency. The local BSP
 * checker compiles it on the host and verifies the fail-closed behavior for an
 * absent /dev/e1-npu-equivalent path.
 */

#include "e1_npu_runtime.h"

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <sstream>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace eliza {
namespace e1_npu {

namespace {

std::string ErrnoReason(const char *prefix, int error) {
	std::ostringstream out;
	out << prefix << "_" << std::strerror(error);
	return out.str();
}

}  // namespace

ProbeResult ProbeDevice(const std::string &device_path) {
	ProbeResult result;
	result.device_node_present = false;
	result.runtime_supported = false;
	result.nnapi_acceleration = false;
	result.open_errno = 0;
	result.status = "unsupported";
	result.reason = "not_probed";

	int fd = open(device_path.c_str(), O_RDONLY | O_CLOEXEC);
	if (fd < 0) {
		result.open_errno = errno;
		result.reason = ErrnoReason("open_failed", result.open_errno);
		return result;
	}

	result.device_node_present = true;

	struct stat st;
	if (fstat(fd, &st) != 0) {
		result.open_errno = errno;
		result.reason = ErrnoReason("fstat_failed", result.open_errno);
		close(fd);
		return result;
	}

	if (!S_ISCHR(st.st_mode)) {
		result.reason = "not_character_device";
		close(fd);
		return result;
	}

	result.runtime_supported = true;
	result.status = "fixed_vector_smoke_required";
	result.reason = "character_device_present_no_nnapi_claim";
	close(fd);
	return result;
}

std::string FormatProbeResult(const std::string &device_path, const ProbeResult &result) {
	std::ostringstream out;
	out << "e1_npu_status=" << result.status << "\n";
	out << "device_path=" << device_path << "\n";
	out << "device_node_present=" << (result.device_node_present ? "true" : "false") << "\n";
	out << "runtime_supported=" << (result.runtime_supported ? "true" : "false") << "\n";
	out << "nnapi_acceleration=" << (result.nnapi_acceleration ? "true" : "false") << "\n";
	out << "reason=" << result.reason << "\n";
	out << "claim_boundary=no_nnapi_acceleration_without_android_nnapi_hal_and_device_evidence\n";
	return out.str();
}

}  // namespace e1_npu
}  // namespace eliza
