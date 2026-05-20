// SPDX-License-Identifier: GPL-2.0-only
/*
 * e1-npu-ml-smoke: boot-time userspace ML smoke for /dev/e1-npu.
 *
 * This deterministic Linux target workload uses the checked-in e1 NPU ioctl
 * ABI and rejects CPU-only fallback by requiring the kernel driver to execute
 * one bounded GEMM_S8 tile.
 */

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#include "e1-npu-uapi.h"

#define E1_NPU_DEV "/dev/e1-npu"
#define E1_NPU_BASE 0x10020000u
#define E1_NPU_WORKLOAD "gemm_s8_int8_2x2x3"

struct smoke_options {
	const char *device;
	const char *workload;
	int require_npu;
};

static void usage(const char *program)
{
	fprintf(stderr,
		"usage: %s [--device /dev/e1-npu] [--workload gemm_s8_int8_2x2x3] [--require-npu]\n",
		program);
}

static int parse_options(int argc, char **argv, struct smoke_options *options)
{
	int i;

	options->device = E1_NPU_DEV;
	options->workload = E1_NPU_WORKLOAD;
	options->require_npu = 0;

	for (i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--device") == 0) {
			if (i + 1 >= argc) {
				usage(argv[0]);
				return 2;
			}
			options->device = argv[++i];
		} else if (strcmp(argv[i], "--workload") == 0) {
			if (i + 1 >= argc) {
				usage(argv[0]);
				return 2;
			}
			options->workload = argv[++i];
		} else if (strcmp(argv[i], "--require-npu") == 0) {
			options->require_npu = 1;
		} else {
			usage(argv[0]);
			return 2;
		}
	}

	if (strcmp(options->workload, E1_NPU_WORKLOAD) != 0) {
		fprintf(stderr,
			"unsupported workload: %s (expected %s)\n",
			options->workload, E1_NPU_WORKLOAD);
		return 2;
	}

	return 0;
}

static void print_matrix(const int32_t *c)
{
	printf("[[%d,%d],[%d,%d]]", c[0], c[1], c[2], c[3]);
}

int main(int argc, char **argv)
{
	static const int32_t expected[] = { -44, 8, 139, -54 };
	struct smoke_options options;
	struct e1_npu_contract contract;
	struct e1_npu_cmd relu;
	struct e1_npu_gemm_s8 gemm;
	struct e1_npu_counters counters;
	unsigned int i;
	int fd;
	int rc;

	rc = parse_options(argc, argv, &options);
	if (rc)
		return rc;

	memset(&gemm, 0, sizeof(gemm));
	memset(&relu, 0, sizeof(relu));
	memset(&counters, 0, sizeof(counters));
	memset(&contract, 0, sizeof(contract));
	relu.opcode = E1_NPU_OP_RELU4_S8;
	relu.a = 0x800700fcu;
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

	fd = open(options.device, O_RDWR | O_CLOEXEC);
	if (fd < 0) {
		fprintf(stderr, "%s: %s\n", options.device, strerror(errno));
		fprintf(stderr, "CPU-only fallback rejected: e1 NPU device is required\n");
		return 2;
	}

	if (ioctl(fd, E1_NPU_IOC_GET_CONTRACT, &contract) < 0) {
		fprintf(stderr, "E1_NPU_IOC_GET_CONTRACT: %s\n", strerror(errno));
		close(fd);
		return 3;
	}
	if (contract.version != 1 || contract.npu_base != 0x10020000 ||
	    contract.scratch_bytes != E1_NPU_SCRATCH_BYTES) {
		fprintf(stderr,
			"unexpected NPU contract: version=%u base=0x%08x scratch=%u\n",
			contract.version, contract.npu_base, contract.scratch_bytes);
		close(fd);
		return 3;
	}

	if (ioctl(fd, E1_NPU_IOC_RUN_CMD, &relu) < 0) {
		fprintf(stderr, "E1_NPU_IOC_RUN_CMD RELU4_S8: %s\n", strerror(errno));
		close(fd);
		return 4;
	}
	if (relu.result != 0x00070000u) {
		fprintf(stderr, "RELU4_S8 mismatch: got=0x%08x expected=0x00070000\n",
			relu.result);
		close(fd);
		return 5;
	}

	if (ioctl(fd, E1_NPU_IOC_RUN_GEMM_S8, &gemm) < 0) {
		fprintf(stderr, "E1_NPU_IOC_RUN_GEMM_S8: %s\n", strerror(errno));
		close(fd);
		return 6;
	}

	for (i = 0; i < 4; i++) {
		if (gemm.c[i] != expected[i]) {
			fprintf(stderr, "GEMM_S8 mismatch at C[%u]: got=%d expected=%d\n",
				i, gemm.c[i], expected[i]);
			close(fd);
			return 7;
		}
	}

	if (ioctl(fd, E1_NPU_IOC_GET_COUNTERS, &counters) < 0)
		fprintf(stderr, "E1_NPU_IOC_GET_COUNTERS: %s\n", strerror(errno));

	printf("eliza-evidence: target=linux artifact=e1_npu_ml_smoke\n");
	printf("eliza-evidence: command=%s --device %s --workload %s%s\n",
	       argv[0], options.device, options.workload,
	       options.require_npu ? " --require-npu" : "");
	printf("eliza-evidence: device=%s\n", options.device);
	printf("eliza-evidence: require_npu=%s\n", options.require_npu ? "true" : "false");
	printf("eliza-evidence: contract_version=%u npu_base=0x%08x scratch_bytes=%u\n",
	       contract.version, contract.npu_base, contract.scratch_bytes);
	printf("eliza-evidence: workload=relu4_s8\n");
	printf("eliza-evidence: workload=%s\n", E1_NPU_WORKLOAD);
	printf("eliza-evidence: input_sha256=860fe3aa9f5e4b5515d4a0a671db874748650cc4fdae1548dc7ee4f0a057a8ed\n");
	printf("eliza-evidence: output_sha256=d70386994e16722852e1149ff822f99cb1bc13cf4ebdeceaa5aa8b2eedf5e386\n");
	printf("e1-npu-ml-smoke: PASS workload=%s c=", E1_NPU_WORKLOAD);
	print_matrix(gemm.c);
	printf("\n");
	printf("e1-npu-ml-smoke: PASS workload=relu4_s8 result=0x%08x", relu.result);
	printf(" cycles=%u macs=%u ops=%u errors=%u unsupported_ops=%u ",
	       counters.perf_cycles, counters.perf_macs, counters.perf_ops,
	       counters.perf_errors, counters.perf_unsupported_ops);
	printf("desc_bytes_read=%u desc_bytes_written=%u desc_read_beats=%u desc_write_beats=%u desc_timeout_count=%u ",
	       counters.desc_bytes_read, counters.desc_bytes_written,
	       counters.desc_read_beats, counters.desc_write_beats,
	       counters.desc_timeout_count);
	printf("status=0x%08x claim_boundary=driver_ioctl_gemm_only_not_nnapi_or_hardware_benchmark\n",
	       gemm.status);
	printf("eliza-evidence: status=PASS\n");

	close(fd);
	return 0;
}
