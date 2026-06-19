// SPDX-License-Identifier: Apache-2.0
#ifndef ELIZA_E1_NPU_RUNTIME_H_
#define ELIZA_E1_NPU_RUNTIME_H_

#include <string>

namespace eliza {
namespace e1_npu {

struct ProbeResult {
	bool device_node_present;
	bool runtime_supported;
	bool fixed_vector_smoke_passed;
	bool nnapi_acceleration;
	int open_errno;
	std::string status;
	std::string reason;
};

ProbeResult ProbeDevice(const std::string &device_path);
std::string FormatProbeResult(const std::string &device_path, const ProbeResult &result);

}  // namespace e1_npu
}  // namespace eliza

#endif  // ELIZA_E1_NPU_RUNTIME_H_
