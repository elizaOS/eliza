// SPDX-License-Identifier: Apache-2.0

#include "e1_npu_runtime.h"

#include <iostream>
#include <string>

int main(int argc, char **argv) {
	std::string device_path = "/dev/e1-npu";

	for (int i = 1; i < argc; ++i) {
		std::string arg = argv[i];
		if (arg == "--device" && i + 1 < argc) {
			device_path = argv[++i];
		} else {
			std::cerr << "usage: " << argv[0] << " [--device PATH]\n";
			return 2;
		}
	}

	const eliza::e1_npu::ProbeResult result =
		eliza::e1_npu::ProbeDevice(device_path);
	std::cout << eliza::e1_npu::FormatProbeResult(device_path, result);

	if (result.nnapi_acceleration) {
		std::cerr << "error: host probe must never claim NNAPI acceleration\n";
		return 1;
	}
	return 0;
}
