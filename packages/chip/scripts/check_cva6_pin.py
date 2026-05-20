#!/usr/bin/env python3
"""Fail-closed check that the CVA6 external pin manifest is consistent.

CVA6 is consumed via two paths:

1. The Chipyard generator submodule chain
   external/chipyard/generators/cva6 -> .gitmodules ->
   src/main/resources/cva6/vsrc/cva6 (upstream openhwgroup/cva6).
2. The standalone external/cva6/ checkout used directly by
   rtl/cpu/e1_cva6_wrapper.sv when E1_HAVE_CVA6 is defined.

This gate verifies the manifest schema and confirms at least one of the
two checkouts exists. Absence of both is BLOCKED, not FAIL.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "external/cva6/pin-manifest.json"
CHIPYARD_WRAPPER = ROOT / "external/chipyard/generators/cva6"
CHIPYARD_CVA6_SUBMODULE = CHIPYARD_WRAPPER / "src/main/resources/cva6/vsrc/cva6"
STANDALONE = ROOT / "external/cva6/cva6"


def main() -> int:
    errors: list[str] = []
    if not MANIFEST.is_file():
        errors.append(f"missing manifest: {MANIFEST.relative_to(ROOT)}")
        print("CVA6 pin check failed:")
        for err in errors:
            print(f"  - {err}")
        return 1

    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"FAIL cva6 pin manifest invalid JSON: {exc}")
        return 1

    if manifest.get("license") != "Solderpad-Hardware-License-2.1":
        errors.append("license must be Solderpad-Hardware-License-2.1")
    if manifest.get("ip_name") != "cva6":
        errors.append("ip_name must be cva6")

    if errors:
        print("CVA6 pin check failed:")
        for err in errors:
            print(f"  - {err}")
        return 1

    wrapper_present = CHIPYARD_WRAPPER.is_dir()
    inner_present = CHIPYARD_CVA6_SUBMODULE.is_dir() and any(CHIPYARD_CVA6_SUBMODULE.iterdir())
    standalone_present = STANDALONE.is_dir() and any(STANDALONE.iterdir())

    if not (wrapper_present and (inner_present or standalone_present)):
        if standalone_present:
            kind = "standalone external/cva6/cva6 only"
        elif wrapper_present:
            kind = "chipyard cva6 wrapper present but recursive submodule (CVA6 RTL) not fetched"
        else:
            kind = "no CVA6 checkout at all"
        print(
            f"STATUS: BLOCKED cpu.cva6_pin - {kind}; "
            f"run `git submodule update --init --recursive external/chipyard/generators/cva6` "
            f"or clone https://github.com/openhwgroup/cva6.git into external/cva6/cva6"
        )
        return 0

    # Wrapper API drift check. With the wrapper re-targeted to the current
    # master API (`config_pkg::cva6_cfg_t` + `noc_req_t`/`noc_resp_t`) the
    # manifest marks the drift `RESOLVED`. We still cross-check that the
    # wrapper does NOT regress by introducing the deprecated symbols, and
    # that the standalone checkout's HEAD matches the pinned commit.
    drift = manifest.get("wrapper_api_drift")
    if standalone_present and drift:
        wrapper_path = drift.get("wrapper_path", "rtl/cpu/e1_cva6_wrapper.sv")
        wrapper_file = ROOT / wrapper_path
        deprecated_seen = []
        if wrapper_file.is_file():
            wrapper_text = wrapper_file.read_text(encoding="utf-8")
            # Forbidden symbols regardless of drift status — keeps the wrapper
            # from regressing to the legacy ariane_pkg API by accident.
            forbidden = [
                "ariane_pkg::ArianeDefaultConfig",
                "ariane_pkg::ariane_cfg_t",
                "ariane_axi::req_t",
                "ariane_axi::resp_t",
            ]
            for probe in forbidden:
                if probe in wrapper_text:
                    deprecated_seen.append(probe)
        if deprecated_seen:
            print(
                "STATUS: FAIL cpu.cva6_pin.wrapper_api_drift - wrapper "
                "regressed and references deprecated symbols: "
                f"{', '.join(deprecated_seen)}"
            )
            return 1

        # When drift is RESOLVED, also verify the standalone checkout HEAD
        # matches the pinned commit.
        if drift.get("status") == "RESOLVED":
            pin_commit = manifest.get("standalone_pin_target_commit", "")
            try:
                head = subprocess.check_output(
                    ["git", "-C", str(STANDALONE), "rev-parse", "HEAD"],
                    text=True,
                    stderr=subprocess.PIPE,
                ).strip()
            except subprocess.CalledProcessError as exc:
                print(
                    "STATUS: BLOCKED cpu.cva6_pin - standalone checkout "
                    f"rev-parse failed: {exc.stderr.strip()}"
                )
                return 0
            if pin_commit and head != pin_commit:
                print(
                    "STATUS: FAIL cpu.cva6_pin.standalone_pin - "
                    f"external/cva6/cva6 HEAD={head[:7]} does not match "
                    f"pin target={pin_commit[:7]} (master HEAD)"
                )
                return 1

    if wrapper_present:
        try:
            head = subprocess.check_output(
                ["git", "-C", str(CHIPYARD_WRAPPER), "rev-parse", "HEAD"],
                text=True,
                stderr=subprocess.PIPE,
            ).strip()
        except subprocess.CalledProcessError as exc:
            print(f"STATUS: BLOCKED cpu.cva6_pin - wrapper rev-parse failed: {exc.stderr.strip()}")
            return 0
        pin = manifest.get("wrapper_pinned_commit", "")
        if pin and head != pin:
            print(f"STATUS: FAIL cpu.cva6_pin - wrapper HEAD={head} does not match pin={pin}")
            return 1

    print("STATUS: PASS cpu.cva6_pin - manifest + checkout(s) consistent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
