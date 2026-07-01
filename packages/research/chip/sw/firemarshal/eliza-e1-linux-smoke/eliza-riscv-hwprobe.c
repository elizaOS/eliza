#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_arch_specific_syscall
#define __NR_arch_specific_syscall 244
#endif

#ifndef __NR_riscv_hwprobe
#define __NR_riscv_hwprobe (__NR_arch_specific_syscall + 14)
#endif

#define RISCV_HWPROBE_KEY_MVENDORID 0
#define RISCV_HWPROBE_KEY_MARCHID 1
#define RISCV_HWPROBE_KEY_MIMPID 2
#define RISCV_HWPROBE_KEY_BASE_BEHAVIOR 3
#define RISCV_HWPROBE_KEY_IMA_EXT_0 4
#define RISCV_HWPROBE_KEY_CPUPERF_0 5

struct riscv_hwprobe_pair {
	long long key;
	unsigned long long value;
};

static const char *key_name(long long key) {
	switch (key) {
	case RISCV_HWPROBE_KEY_MVENDORID:
		return "mvendorid";
	case RISCV_HWPROBE_KEY_MARCHID:
		return "marchid";
	case RISCV_HWPROBE_KEY_MIMPID:
		return "mimpid";
	case RISCV_HWPROBE_KEY_BASE_BEHAVIOR:
		return "base_behavior";
	case RISCV_HWPROBE_KEY_IMA_EXT_0:
		return "ima_ext_0";
	case RISCV_HWPROBE_KEY_CPUPERF_0:
		return "cpuperf_0";
	default:
		return "unknown";
	}
}

int main(void) {
	struct riscv_hwprobe_pair pairs[] = {
		{RISCV_HWPROBE_KEY_MVENDORID, 0},
		{RISCV_HWPROBE_KEY_MARCHID, 0},
		{RISCV_HWPROBE_KEY_MIMPID, 0},
		{RISCV_HWPROBE_KEY_BASE_BEHAVIOR, 0},
		{RISCV_HWPROBE_KEY_IMA_EXT_0, 0},
		{RISCV_HWPROBE_KEY_CPUPERF_0, 0},
	};
	long rc;

	errno = 0;
	rc = syscall(__NR_riscv_hwprobe, pairs, sizeof(pairs) / sizeof(pairs[0]), 0, 0, 0);
	if (rc != 0) {
		printf("riscv_hwprobe: syscall rc=%ld errno=%d error=%s\n", rc, errno, strerror(errno));
		return 1;
	}

	printf("riscv_hwprobe: syscall rc=0 pair_count=%zu\n", sizeof(pairs) / sizeof(pairs[0]));
	for (size_t i = 0; i < sizeof(pairs) / sizeof(pairs[0]); ++i) {
		printf("riscv_hwprobe: key=%s value=0x%016llx\n", key_name(pairs[i].key), pairs[i].value);
	}
	return 0;
}
