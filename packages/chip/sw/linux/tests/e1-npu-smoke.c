// SPDX-License-Identifier: GPL-2.0-only
/*
 * Standalone Linux-side source smoke for /dev/e1-npu.
 *
 * Build with:
 *   cc -Wall -Wextra -Werror -I sw/linux/drivers/e1 \
 *      -o e1-npu-smoke sw/linux/tests/e1-npu-smoke.c
 */

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#include "e1-npu-uapi.h"

static void print_matrix(const int32_t *c)
{
	printf("[[%d,%d],[%d,%d]]", c[0], c[1], c[2], c[3]);
}

static int run_dot_smoke(int fd)
{
	struct e1_npu_cmd cmd;

	memset(&cmd, 0, sizeof(cmd));
	cmd.opcode = E1_NPU_OP_DOT4_S8;
	cmd.a = 0x04fd0201u;
	cmd.b = 0x08f70605u;
	cmd.acc = 11;

	if (ioctl(fd, E1_NPU_IOC_RUN_CMD, &cmd) < 0) {
		fprintf(stderr, "E1_NPU_IOC_RUN_CMD: %s\n", strerror(errno));
		return 3;
	}
	if (cmd.result != 70) {
		fprintf(stderr, "DOT4_S8 mismatch: got=%u expected=70 status=0x%08x\n",
			cmd.result, cmd.status);
		return 4;
	}

	printf("eliza-evidence: workload=dot4_s8 scalar_result=%u status=0x%08x\n",
	       cmd.result, cmd.status);
	return 0;
}

static int run_smoke(const char *device)
{
	static const int32_t expected[] = { -44, 8, 139, -54 };
	struct e1_npu_contract contract;
	struct e1_npu_gemm_s8 gemm;
	struct e1_npu_counters counters;
	unsigned int i;
	int fd;

	memset(&contract, 0, sizeof(contract));
	memset(&gemm, 0, sizeof(gemm));
	memset(&counters, 0, sizeof(counters));
	gemm.m = 2;
	gemm.n = 2;
	gemm.k = 3;
	gemm.a[0] = 1;
	gemm.a[1] = -2;
	gemm.a[2] = 3;
	gemm.a[3] = 4;
	gemm.a[4] = 5;
	gemm.a[5] = -6;
	gemm.b[0] = 7;
	gemm.b[1] = -8;
	gemm.b[2] = 9;
	gemm.b[3] = 10;
	gemm.b[4] = -11;
	gemm.b[5] = 12;

	fd = open(device, O_RDWR | O_CLOEXEC);
	if (fd < 0) {
		fprintf(stderr, "%s: %s\n", device, strerror(errno));
		fprintf(stderr, "CPU-only fallback rejected: e1 NPU device is required\n");
		return 2;
	}

	if (ioctl(fd, E1_NPU_IOC_GET_CONTRACT, &contract) < 0) {
		fprintf(stderr, "E1_NPU_IOC_GET_CONTRACT: %s\n", strerror(errno));
		close(fd);
		return 3;
	}
	if (contract.version != 1 || contract.npu_base != 0x10020000u ||
	    contract.scratch_bytes != E1_NPU_SCRATCH_BYTES) {
		fprintf(stderr, "contract mismatch: version=%u npu_base=0x%08x scratch=%u\n",
			contract.version, contract.npu_base, contract.scratch_bytes);
		close(fd);
		return 3;
	}

	i = run_dot_smoke(fd);
	if (i) {
		close(fd);
		return i;
	}

	if (ioctl(fd, E1_NPU_IOC_RUN_GEMM_S8, &gemm) < 0) {
		fprintf(stderr, "E1_NPU_IOC_RUN_GEMM_S8: %s\n", strerror(errno));
		close(fd);
		return 5;
	}

	for (i = 0; i < 4; i++) {
		if (gemm.c[i] != expected[i]) {
			fprintf(stderr, "GEMM_S8 mismatch at C[%u]: got=%d expected=%d\n",
				i, gemm.c[i], expected[i]);
			close(fd);
			return 6;
		}
	}

	if (ioctl(fd, E1_NPU_IOC_GET_COUNTERS, &counters) < 0)
		fprintf(stderr, "E1_NPU_IOC_GET_COUNTERS: %s\n", strerror(errno));

	printf("eliza-evidence: target=linux artifact=e1_npu_ml_smoke\n");
	printf("eliza-evidence: device=%s\n", device);
	printf("eliza-evidence: workload=gemm_s8_int8_2x2x3\n");
	printf("eliza-evidence: input_sha256=860fe3aa9f5e4b5515d4a0a671db874748650cc4fdae1548dc7ee4f0a057a8ed\n");
	printf("eliza-evidence: output_sha256=d70386994e16722852e1149ff822f99cb1bc13cf4ebdeceaa5aa8b2eedf5e386\n");
	printf("e1-npu-ml-smoke: PASS workload=gemm_s8_int8_2x2x3 c=");
	print_matrix(gemm.c);
	printf(" cycles=%u macs=%u ops=%u errors=%u unsupported_ops=%u ",
	       counters.perf_cycles, counters.perf_macs, counters.perf_ops,
	       counters.perf_errors, counters.perf_unsupported_ops);
	printf("desc_bytes_read=%u desc_timeout_count=%u ",
	       counters.desc_bytes_read, counters.desc_timeout_count);
	printf("status=0x%08x descriptor_submit_ioctl=0x%lx ",
	       gemm.status, (unsigned long)E1_NPU_IOC_SUBMIT_DESCRIPTORS);
	printf("claim_boundary=driver_ioctl_gemm_only_not_nnapi_or_hardware_benchmark\n");
	printf("eliza-evidence: status=PASS\n");

	close(fd);
	return 0;
}

int main(int argc, char **argv)
{
	const char *device = "/dev/e1-npu";

	if (argc == 3 && strcmp(argv[1], "--device") == 0) {
		device = argv[2];
	} else if (argc != 1) {
		fprintf(stderr, "usage: %s [--device /dev/e1-npu]\n", argv[0]);
		return 64;
	}

	return run_smoke(device);
}
