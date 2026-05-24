// SPDX-License-Identifier: Apache-2.0
/*
 * Host-buildable runtime probe for the e1_npu.default HAL.
 *
 * This file intentionally has no Android framework dependency. The local BSP
 * checker compiles it on the host and verifies both fail-closed behavior for an
 * absent /dev/e1-npu-equivalent path and the fixed-vector ioctl contract used
 * by the Android HAL when a compatible device node is present.
 */

#include "e1_npu_runtime.h"
#include "e1_npu/E1NpuUapi.h"

#include <cerrno>
#include <cstdint>
#include <cstring>
#include <fcntl.h>
#include <sstream>
#include <string>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace eliza {
namespace e1_npu {

namespace {

constexpr uint32_t kExpectedNpuBase = 0x10020000u;
constexpr uint32_t kExpectedReluResult = 0x00070000u;
constexpr int32_t kExpectedGemm[4] = { -44, 8, 139, -54 };

std::string ErrnoReason(const char *prefix, int error) {
	std::ostringstream out;
	out << prefix << "_" << std::strerror(error);
	return out.str();
}

void FillGemm(e1_npu_gemm_s8 *gemm) {
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

bool GemmMatches(const e1_npu_gemm_s8 &gemm, std::string *reason) {
	for (size_t i = 0; i < 4; ++i) {
		if (gemm.c[i] != kExpectedGemm[i]) {
			std::ostringstream out;
			out << "gemm_mismatch_c" << i << "_got_" << gemm.c[i]
			    << "_expected_" << kExpectedGemm[i];
			*reason = out.str();
			return false;
		}
	}
	return true;
}

}  // namespace

ProbeResult ProbeDevice(const std::string &device_path) {
	ProbeResult result;
	result.device_node_present = false;
	result.runtime_supported = false;
	result.fixed_vector_smoke_passed = false;
	result.nnapi_acceleration = false;
	result.open_errno = 0;
	result.status = "device_absent";
	result.reason = "not_probed";

	int fd = open(device_path.c_str(), O_RDWR | O_CLOEXEC);
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

	e1_npu_contract contract = {};
	if (ioctl(fd, E1_NPU_IOC_GET_CONTRACT, &contract) < 0) {
		result.open_errno = errno;
		result.status = "ioctl_smoke_failed";
		result.reason = ErrnoReason("get_contract_failed", result.open_errno);
		close(fd);
		return result;
	}
	if (contract.version != 1 || contract.npu_base != kExpectedNpuBase ||
	    contract.scratch_bytes != E1_NPU_SCRATCH_BYTES) {
		std::ostringstream out;
		out << "contract_mismatch_version_" << contract.version
		    << "_base_0x" << std::hex << contract.npu_base
		    << "_scratch_" << std::dec << contract.scratch_bytes;
		result.status = "ioctl_smoke_failed";
		result.reason = out.str();
		close(fd);
		return result;
	}

	e1_npu_cmd relu = {};
	relu.opcode = E1_NPU_OP_RELU4_S8;
	relu.a = 0x800700fcu;
	if (ioctl(fd, E1_NPU_IOC_RUN_CMD, &relu) < 0) {
		result.open_errno = errno;
		result.status = "ioctl_smoke_failed";
		result.reason = ErrnoReason("relu4_s8_failed", result.open_errno);
		close(fd);
		return result;
	}
	if (relu.result != kExpectedReluResult) {
		std::ostringstream out;
		out << "relu4_s8_mismatch_got_0x" << std::hex << relu.result
		    << "_expected_0x" << kExpectedReluResult;
		result.status = "ioctl_smoke_failed";
		result.reason = out.str();
		close(fd);
		return result;
	}

	e1_npu_gemm_s8 gemm = {};
	FillGemm(&gemm);
	if (ioctl(fd, E1_NPU_IOC_RUN_GEMM_S8, &gemm) < 0) {
		result.open_errno = errno;
		result.status = "ioctl_smoke_failed";
		result.reason = ErrnoReason("gemm_s8_failed", result.open_errno);
		close(fd);
		return result;
	}
	if (!GemmMatches(gemm, &result.reason)) {
		result.status = "ioctl_smoke_failed";
		close(fd);
		return result;
	}

	result.runtime_supported = true;
	result.fixed_vector_smoke_passed = true;
	result.status = "fixed_vector_smoke_passed";
	result.reason = "contract_relu4_gemm_s8_passed_no_nnapi_claim";
	close(fd);
	return result;
}

std::string FormatProbeResult(const std::string &device_path, const ProbeResult &result) {
	std::ostringstream out;
	out << "e1_npu_status=" << result.status << "\n";
	out << "device_path=" << device_path << "\n";
	out << "device_node_present=" << (result.device_node_present ? "true" : "false") << "\n";
	out << "runtime_supported=" << (result.runtime_supported ? "true" : "false") << "\n";
	out << "fixed_vector_smoke_passed=" << (result.fixed_vector_smoke_passed ? "true" : "false") << "\n";
	out << "nnapi_acceleration=" << (result.nnapi_acceleration ? "true" : "false") << "\n";
	out << "reason=" << result.reason << "\n";
	out << "claim_boundary=no_nnapi_acceleration_without_android_nnapi_hal_and_device_evidence\n";
	return out.str();
}

}  // namespace e1_npu
}  // namespace eliza
