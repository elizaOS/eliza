#!/usr/bin/env python3
"""Tests for scripts/check_cross_fork_agent_payload_contract.py."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import check_cross_fork_agent_payload_contract as gate  # noqa: E402


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def bun_version_json(webkit_status: str = "") -> str:
    return json.dumps(
        {
            "bun": {"tag": "bun-v1.3.13", "channel": "canary"},
            "artifact": {
                "filename": "bun-linux-riscv64-musl.zip",
                "internal_layout": "bun-linux-riscv64-musl/bun",
            },
            "patch_series": {"webkit_recipes_status": webkit_status},
        }
    )


def good_bun_riscv64_dockerfile() -> str:
    return r"""RUN set -eux; \
    install -d /opt/cross/bin; \
    cat > /opt/cross/bin/riscv64-linux-musl-clang <<'WRAPPER_EOF'
#!/bin/sh
exec /usr/local/bin/clang \
    --target=riscv64-unknown-linux-musl \
    --sysroot=/sysroot \
    --gcc-toolchain=/sysroot/usr \
    -Qunused-arguments \
    -B/sysroot/usr/lib/gcc/riscv64-alpine-linux-musl/14.2.0 \
    -L/sysroot/usr/lib/gcc/riscv64-alpine-linux-musl/14.2.0 \
    -L/sysroot/usr/lib \
    -fuse-ld=lld \
    -march=rv64gc \
    -mabi=lp64d \
    "$@"
WRAPPER_EOF
RUN cat > /opt/cross/bin/riscv64-linux-musl-clang++ <<'WRAPPER_EOF'
#!/bin/sh
exec /usr/local/bin/clang++ \
    --target=riscv64-unknown-linux-musl \
    --sysroot=/sysroot \
    --gcc-toolchain=/sysroot/usr \
    -Qunused-arguments \
    -B/sysroot/usr/lib/gcc/riscv64-alpine-linux-musl/14.2.0 \
    -L/sysroot/usr/lib/gcc/riscv64-alpine-linux-musl/14.2.0 \
    -L/sysroot/usr/lib \
    -fuse-ld=lld \
    -stdlib=libstdc++ \
    -march=rv64gc \
    -mabi=lp64d \
    "$@"
WRAPPER_EOF
RUN ln -s /usr/local/bin/ld.lld /opt/cross/bin/riscv64-linux-musl-ld
ENV CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_MUSL_LINKER=/opt/cross/bin/riscv64-linux-musl-clang
"""


def good_bun_riscv64_build_sh() -> str:
    return r"""WK_LINKER_FLAGS="-fuse-ld=lld"
cmake \
    -DCMAKE_LINKER=/usr/local/bin/ld.lld \
    -DCMAKE_EXE_LINKER_FLAGS_INIT="${WK_LINKER_FLAGS}" \
    -DCMAKE_SHARED_LINKER_FLAGS_INIT="${WK_LINKER_FLAGS}" \
    -DCMAKE_MODULE_LINKER_FLAGS_INIT="${WK_LINKER_FLAGS}"
export BUN_LD=/usr/local/bin/ld.lld
"""


class CrossForkAgentPayloadContractTests(unittest.TestCase):
    def _patch_tree(self, tmp: Path):
        workspace = tmp
        app_core = workspace / "app-core"
        os_rv64 = workspace / "os/linux/elizaos"
        bun_version = write(
            app_core / "scripts/bun-riscv64/bun-version.json",
            bun_version_json(
                "Recipe files document the chain that an operator must realize into actual `*.patch` files before the Baseline-JIT build path is testable."
            ),
        )
        bun_riscv64_dockerfile = write(
            app_core / "scripts/bun-riscv64/Dockerfile",
            good_bun_riscv64_dockerfile(),
        )
        bun_riscv64_build = write(
            app_core / "scripts/bun-riscv64/build.sh",
            good_bun_riscv64_build_sh(),
        )
        android_stage = write(
            app_core / "scripts/lib/stage-android-agent.mjs",
            'const BUN_VERSION = "1.3.13";\n'
            'const DEFAULT_BUN_CHANNEL = "canary";\n'
            "const ABI_TARGETS = [{ androidAbi: 'riscv64' }];\n"
            "const url = process.env.ELIZA_BUN_RISCV64_URL;\n",
        )
        android_service = write(
            app_core
            / "platforms/android/app/src/main/java/ai/milady/milady/ElizaAgentService.java",
            'private static final String HEALTH_URL = "http://127.0.0.1:31337/api/health";\n',
        )
        linux_agent_hook = write(
            os_rv64 / "config/hooks/normal/0010-elizaos-agent.hook.chroot",
            '{"stage": "placeholder", "provenance": "scaffolding"}\n'
            "install_fallback_payload() { echo elizaos-fallback > fallback_agent.py; }\n",
        )
        linux_unit = write(
            os_rv64 / "config/includes.chroot/etc/systemd/system/elizaos-agent.service",
            "[Service]\nExecStart=/opt/elizaos/bin/elizaos start --headless --port=31337\n",
        )
        linux_health_helper = write(
            os_rv64 / "config/includes.chroot/usr/lib/elizaos/wait-agent-health.sh",
            "#!/bin/sh\nexit 1\n",
        )
        linux_tui_smoke_unit = write(
            os_rv64
            / "config/includes.chroot/etc/systemd/system/elizaos-terminal-tui-smoke.service",
            "[Unit]\nAfter=elizaos-agent.service\n",
        )
        linux_manifest_template = write(
            os_rv64 / "manifest.json.template",
            json.dumps({"validation": {"qemuBoot": {"status": "missing"}}}),
        )
        write(
            os_rv64 / "docs/status.md",
            "touch /opt/elizaos/STATUS_LATER_AGENT_BINARY\n",
        )
        patches = [
            mock.patch.object(gate, "WORKSPACE", workspace),
            mock.patch.object(gate, "APP_CORE", app_core),
            mock.patch.object(gate, "OS_RV64", os_rv64),
            mock.patch.object(gate, "BUN_VERSION_JSON", bun_version),
            mock.patch.object(gate, "BUN_RISCV64_DOCKERFILE", bun_riscv64_dockerfile),
            mock.patch.object(gate, "BUN_RISCV64_BUILD", bun_riscv64_build),
            mock.patch.object(gate, "ANDROID_STAGE", android_stage),
            mock.patch.object(gate, "ANDROID_AGENT_SERVICE", android_service),
            mock.patch.object(
                gate,
                "ANDROID_AGENT_SERVICE_CANDIDATES",
                (
                    android_service,
                    app_core
                    / "platforms/android/app/src/main/java/ai/elizaos/app/ElizaAgentService.java",
                ),
            ),
            mock.patch.object(gate, "LINUX_AGENT_HOOK", linux_agent_hook),
            mock.patch.object(gate, "LINUX_AGENT_UNIT", linux_unit),
            mock.patch.object(gate, "LINUX_HEALTH_HELPER", linux_health_helper),
            mock.patch.object(gate, "LINUX_TUI_SMOKE_UNIT", linux_tui_smoke_unit),
            mock.patch.object(
                gate,
                "LINUX_MANIFEST_CANDIDATES",
                (os_rv64 / "manifest.json", linux_manifest_template),
            ),
        ]
        return patches, os_rv64

    def test_placeholder_cross_fork_payload_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches, _ = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "blocked")
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("android_riscv64_bun_payload_is_url_only", codes)
        self.assertIn("linux_rv64_agent_install_is_placeholder", codes)
        self.assertIn("linux_rv64_status_later_agent_binary_marker", codes)
        self.assertIn("linux_rv64_fallback_agent_can_satisfy_health", codes)
        self.assertIn("linux_rv64_agent_unit_has_no_health_probe", codes)
        self.assertIn("linux_rv64_manifest_missing_agent_health_evidence", codes)
        self.assertIn("linux_rv64_does_not_consume_shared_bun_payload", codes)
        self.assertIn("bun_riscv64_webkit_baseline_patches_not_realized", codes)

    def test_real_payload_contract_passes_static_checks(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            patches, os_rv64 = self._patch_tree(tmp)
            with PatchStack(patches):
                gate.BUN_VERSION_JSON.write_text(
                    bun_version_json("realized patch files validated"), encoding="utf-8"
                )
                gate.ANDROID_STAGE.write_text(
                    'const BUN_VERSION = "1.3.13";\n'
                    'const DEFAULT_BUN_CHANNEL = "canary";\n'
                    "const ABI_TARGETS = [{ androidAbi: 'riscv64' }];\n"
                    "const expectedSha256 = process.env.ELIZA_BUN_RISCV64_SHA256;\n"
                    "const artifact = 'bun-linux-riscv64-musl.zip';\n",
                    encoding="utf-8",
                )
                gate.LINUX_AGENT_HOOK.write_text(
                    "install -m 0755 /artifacts/elizaos /opt/elizaos/bin/elizaos\n"
                    "echo bun-linux-riscv64-musl.zip > /opt/elizaos/INSTALL_STATE.json\n",
                    encoding="utf-8",
                )
                (os_rv64 / "docs/status.md").write_text("agent installed\n", encoding="utf-8")
                gate.LINUX_AGENT_UNIT.write_text(
                    "[Service]\n"
                    "ExecStart=/opt/elizaos/bin/elizaos start --headless --port=31337\n"
                    "ExecStartPost=/usr/lib/elizaos/wait-agent-health.sh http://127.0.0.1:31337/api/health\n",
                    encoding="utf-8",
                )
                gate.LINUX_HEALTH_HELPER.write_text(
                    "#!/bin/sh\ncurl --fail http://127.0.0.1:31337/api/health\n",
                    encoding="utf-8",
                )
                gate.LINUX_TUI_SMOKE_UNIT.write_text(
                    "[Unit]\nAfter=elizaos-agent.service\nRequires=elizaos-agent.service\n",
                    encoding="utf-8",
                )
                gate.LINUX_MANIFEST_CANDIDATES[1].write_text(
                    json.dumps(
                        {
                            "validation": {
                                "requiredEvidence": ["agent-health-live"],
                                "evidence": [{"id": "agent-health-live"}],
                            }
                        }
                    ),
                    encoding="utf-8",
                )
                write(os_rv64 / "docs/runtime.md", "bun-linux-riscv64-musl.zip\n")
                report = gate.run_check(Namespace())
        self.assertEqual(report["status"], "pass")
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["claim_boundary"], gate.CLAIM_BOUNDARY)

    def test_bun_riscv64_toolchain_blocks_host_ld_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            patches, _ = self._patch_tree(Path(tmpdir))
            with PatchStack(patches):
                gate.BUN_VERSION_JSON.write_text(
                    bun_version_json("realized patch files validated"), encoding="utf-8"
                )
                gate.BUN_RISCV64_DOCKERFILE.write_text(
                    good_bun_riscv64_dockerfile().replace("    -fuse-ld=lld \\\n", ""),
                    encoding="utf-8",
                )
                gate.BUN_RISCV64_BUILD.write_text(
                    good_bun_riscv64_build_sh().replace('WK_LINKER_FLAGS="-fuse-ld=lld"\n', ""),
                    encoding="utf-8",
                )
                report = gate.run_check(Namespace())
        codes = {finding["code"] for finding in report["findings"]}
        self.assertIn("bun_riscv64_toolchain_can_use_host_ld", codes)


class PatchStack:
    def __init__(self, patches):
        self._patches = patches
        self._entered = []

    def __enter__(self):
        for patch in self._patches:
            self._entered.append(patch)
            patch.__enter__()
        return self

    def __exit__(self, exc_type, exc, tb):
        while self._entered:
            self._entered.pop().__exit__(exc_type, exc, tb)


if __name__ == "__main__":
    unittest.main()
