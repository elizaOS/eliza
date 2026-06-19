#!/usr/bin/env sh
set -eu

aosp_dir=${AOSP_DIR:-$(pwd)}
target_product=${AOSP_TARGET_PRODUCT:-eliza_ai_soc}
product_out=${AOSP_PRODUCT_OUT:-$aosp_dir/out/target/product/$target_product}
renode=${AOSP_RENODE:-renode}
resc=${AOSP_RENODE_SCRIPT:-}

echo "AOSP_RENODE_SMOKE=repo_default"
echo "AOSP_DIR=$aosp_dir"
echo "TARGET_PRODUCT=$target_product"
echo "PRODUCT_OUT=$product_out"

if [ -z "$resc" ]; then
	for candidate in \
		"$aosp_dir/device/eliza/eliza_ai_soc/renode/eliza_android.resc" \
		"$aosp_dir/device/eliza/eliza_ai_soc/eliza_android.resc" \
		"$product_out/eliza_android.resc"
	do
		if [ -s "$candidate" ]; then
			resc=$candidate
			break
		fi
	done
fi

if [ -z "$resc" ] || [ ! -s "$resc" ]; then
	echo "MISSING_AOSP_RENODE_SCRIPT=${resc:-device/eliza/eliza_ai_soc/renode/eliza_android.resc}"
	echo "AOSP_RENODE_BOOT=blocked_missing_boot_script"
	exit 2
fi

if ! command -v "$renode" >/dev/null 2>&1; then
	echo "MISSING_AOSP_RENODE_BINARY=$renode"
	exit 2
fi

log=${AOSP_RENODE_LOG:-$product_out/eliza-renode-smoke.log}
rm -f "$log"
echo "AOSP_RENODE_SCRIPT=$resc"
echo "AOSP_RENODE_LOG=$log"

"$renode" --disable-xwt --console --execute "include @$resc; logFile @$log; start"

if grep -Eq "sys.boot_completed=1|Android boot completed|init: starting service|Freeing unused kernel memory" "$log"; then
	echo "AOSP_RENODE_BOOT=markers_present"
	exit 0
fi

echo "AOSP_RENODE_BOOT=missing_required_markers"
exit 2
