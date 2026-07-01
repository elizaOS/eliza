#!/usr/bin/env sh
set -eu

aosp_dir=${AOSP_DIR:-$(pwd)}
target_product=${AOSP_TARGET_PRODUCT:-eliza_ai_soc}
product_out=${AOSP_PRODUCT_OUT:-$aosp_dir/out/target/product/$target_product}
timeout_seconds=${AOSP_QEMU_TIMEOUT_SECONDS:-120}
qemu=${AOSP_QEMU:-qemu-system-riscv64}

echo "AOSP_QEMU_SMOKE=repo_default"
echo "AOSP_DIR=$aosp_dir"
echo "TARGET_PRODUCT=$target_product"
echo "PRODUCT_OUT=$product_out"

missing=0
for image in system.img vendor.img; do
	if [ ! -s "$product_out/$image" ]; then
		echo "MISSING_AOSP_QEMU_IMAGE=$product_out/$image"
		missing=1
	fi
done

kernel=${AOSP_QEMU_KERNEL:-}
if [ -z "$kernel" ]; then
	for candidate in \
		"$product_out/kernel" \
		"$product_out/Image" \
		"$aosp_dir/out/target/product/$target_product/kernel" \
		"$aosp_dir/out/target/product/$target_product/Image"
	do
		if [ -s "$candidate" ]; then
			kernel=$candidate
			break
		fi
	done
fi

if [ -z "$kernel" ] || [ ! -s "$kernel" ]; then
	echo "MISSING_AOSP_QEMU_KERNEL=${kernel:-$product_out/kernel}"
	missing=1
fi

if [ "$missing" -ne 0 ]; then
	echo "AOSP_QEMU_BOOT=blocked_missing_boot_artifacts"
	exit 2
fi

if ! command -v "$qemu" >/dev/null 2>&1; then
	echo "MISSING_AOSP_QEMU_BINARY=$qemu"
	exit 2
fi

console_log=${AOSP_QEMU_CONSOLE_LOG:-$product_out/eliza-qemu-smoke-console.log}
rm -f "$console_log"
echo "AOSP_QEMU_KERNEL=$kernel"
echo "AOSP_QEMU_CONSOLE_LOG=$console_log"

timeout "$timeout_seconds" "$qemu" \
	-machine virt \
	-cpu rv64 \
	-m "${AOSP_QEMU_MEMORY:-4096M}" \
	-nographic \
	-kernel "$kernel" \
	-append "${AOSP_QEMU_APPEND:-console=ttyS0 earlycon=sbi root=/dev/vda rw}" \
	-drive "file=$product_out/system.img,format=raw,if=virtio,readonly=on" \
	-drive "file=$product_out/vendor.img,format=raw,if=virtio,readonly=on" \
	-serial "file:$console_log"

if grep -Eq "sys.boot_completed=1|init: starting service|console=ttyS0|Freeing unused kernel memory" "$console_log"; then
	echo "AOSP_QEMU_BOOT=markers_present"
	exit 0
fi

echo "AOSP_QEMU_BOOT=missing_required_markers"
exit 2
