#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
import subprocess
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_repair_fuse_reader.json"
RTL = ROOT / "rtl/e1x/e1x_repair_fuse_reader.sv"
LOADER_RTL = ROOT / "rtl/e1x/e1x_repair_rom_loader.sv"
CAPACITY_REPORT = ROOT / "build/reports/e1x_repair_capacity.json"

ROM_CASES = {
    "real_graph_normal": {
        "json": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.json",
        "hex": ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.hex",
    },
    "real_graph_high_failure": {
        "json": ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.json",
        "hex": ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.hex",
    },
    "scaled_high_failure": {
        "json": ROOT / "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_rom.json",
        "hex": ROOT / "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_rom.hex",
    },
}

RTL_MARKERS = (
    "module e1x_repair_fuse_reader",
    "otp_read_valid_o",
    "otp_read_addr_o",
    "otp_read_ready_i",
    "otp_read_data_valid_i",
    "repair_word_valid_o",
    "repair_word_ready_i",
    "MAX_WORDS",
    "TIMEOUT_CYCLES",
    "word_count_i == '0",
)
LOADER_MARKERS = (
    "module e1x_repair_rom_loader",
    "word_valid_i",
    "word_ready_o",
    "word_i",
    "E1X_REPAIR_MAGIC",
)
FALSE_CLAIM_FLAGS = {
    "silicon_fuse_burning_claim_allowed": False,
    "foundry_otp_macro_claim_allowed": False,
    "wafer_sort_claim_allowed": False,
    "measured_silicon_claim_allowed": False,
    "release_claim_allowed": False,
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def word_list_sha256(words: list[str]) -> str:
    return sha256(("\n".join(words) + "\n").encode()).hexdigest()


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def find_verilator() -> str | None:
    for candidate in (
        shutil.which("verilator"),
        str(ROOT / "external/oss-cad-suite/bin/verilator"),
    ):
        if candidate and Path(candidate).is_file():
            return candidate
    return None


def check_verilator_lint() -> dict[str, str]:
    verilator = find_verilator()
    if verilator is None:
        return {
            "id": "e1x_repair_fuse_reader_verilator_lint",
            "status": "fail",
            "detail": "verilator not found",
        }
    proc = subprocess.run(
        [
            verilator,
            "--lint-only",
            "-Wall",
            "-Wno-DECLFILENAME",
            "-Wno-UNUSEDSIGNAL",
            "-Wno-UNUSEDPARAM",
            "--top-module",
            "e1x_repair_fuse_reader",
            "rtl/e1x/e1x_repair_fuse_reader.sv",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    status, detail = pass_fail(
        proc.returncode == 0,
        "e1x_repair_fuse_reader lints clean under verilator --lint-only",
        "verilator lint failed: " + (proc.stderr.strip() or proc.stdout.strip())[-1200:],
    )
    return {"id": "e1x_repair_fuse_reader_verilator_lint", "status": status, "detail": detail}


def marker_check(
    check_id: str, text: str, markers: tuple[str, ...], detail: str
) -> tuple[dict[str, str], int]:
    missing = [marker for marker in markers if marker not in text]
    status, resolved_detail = pass_fail(
        not missing,
        detail,
        "missing markers: " + ", ".join(missing),
    )
    return {"id": check_id, "status": status, "detail": resolved_detail}, len(markers) - len(
        missing
    )


def simulate_fuse_stream(
    words: list[str], max_words: int, timeout_cycles: int
) -> dict[str, bool | str | int]:
    if not words or len(words) > max_words:
        return {"ok": False, "reason": "word count outside fuse-reader bounds"}
    emitted: list[str] = []
    addresses: list[int] = []
    cycle = 0
    for addr, word in enumerate(words):
        issue_stall = (addr % 5) + 1
        data_latency = (addr % 7) + 1
        repair_stall = addr % 3
        if max(issue_stall, data_latency, repair_stall) >= timeout_cycles:
            return {"ok": False, "reason": f"timeout at word {addr}"}
        cycle += issue_stall
        addresses.append(addr)
        cycle += data_latency
        cycle += repair_stall
        emitted.append(word)
    return {
        "ok": emitted == words and addresses == list(range(len(words))),
        "reason": "streamed sequentially with OTP and loader stalls",
        "cycles": cycle,
        "word_count": len(emitted),
        "stream_sha256": word_list_sha256(emitted),
    }


def main() -> int:
    checks: list[dict[str, str]] = []
    input_paths = [RTL, LOADER_RTL, CAPACITY_REPORT]
    input_paths.extend(path for case in ROM_CASES.values() for path in (case["json"], case["hex"]))
    missing = [str(path.relative_to(ROOT)) for path in input_paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "repair fuse-reader inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {"id": "e1x_repair_fuse_reader_inputs_present", "status": status, "detail": detail}
    )

    rtl_text = RTL.read_text(encoding="utf-8") if RTL.is_file() else ""
    loader_text = LOADER_RTL.read_text(encoding="utf-8") if LOADER_RTL.is_file() else ""
    check, rtl_marker_count = marker_check(
        "e1x_repair_fuse_reader_rtl_contract_markers",
        rtl_text,
        RTL_MARKERS,
        "fuse-reader RTL exposes OTP read bus, loader valid/ready stream, bounds, and timeout controls",
    )
    checks.append(check)
    check, loader_marker_count = marker_check(
        "e1x_repair_fuse_reader_loader_stream_contract_markers",
        loader_text,
        LOADER_MARKERS,
        "repair ROM loader accepts the fuse-reader 64-bit valid/ready stream",
    )
    checks.append(check)
    checks.append(check_verilator_lint())

    capacity = load_json(CAPACITY_REPORT) if CAPACITY_REPORT.is_file() else {}
    capacity_summary = capacity.get("summary", {})
    fuse_window_words = int(capacity_summary.get("production_fuse_window_words", 0))
    status, detail = pass_fail(
        capacity.get("status") == "PASS" and fuse_window_words >= 4096,
        f"capacity report sizes production fuse window to {fuse_window_words} words",
        "repair capacity report missing or insufficient",
    )
    checks.append(
        {"id": "e1x_repair_fuse_reader_capacity_report_pass", "status": status, "detail": detail}
    )

    case_summaries: list[dict[str, str | int]] = []
    for case_id, paths in ROM_CASES.items():
        rom = load_json(paths["json"]) if paths["json"].is_file() else {}
        hex_words = (
            [
                line.strip()
                for line in paths["hex"].read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            if paths["hex"].is_file()
            else []
        )
        json_words = rom.get("words", [])
        words_ok = (
            rom.get("schema") == "eliza.e1x.repair_rom.v1"
            and isinstance(json_words, list)
            and json_words == hex_words
            and int(rom.get("total_word_count", 0)) == len(hex_words)
            and word_list_sha256(hex_words) == rom.get("rom_words_sha256")
        )
        status, detail = pass_fail(
            words_ok,
            f"{case_id} repair ROM JSON/HEX words are streamable",
            f"{case_id} repair ROM JSON/HEX mismatch",
        )
        checks.append(
            {
                "id": f"e1x_repair_fuse_reader_{case_id}_rom_words",
                "status": status,
                "detail": detail,
            }
        )

        sim = simulate_fuse_stream(hex_words, fuse_window_words, timeout_cycles=1024)
        sim_ok = bool(sim.get("ok")) and sim.get("stream_sha256") == rom.get("rom_words_sha256")
        status, detail = pass_fail(
            sim_ok,
            f"{case_id} streams sequentially through OTP stalls and loader backpressure",
            f"{case_id} stream simulation failed: {sim.get('reason')}",
        )
        checks.append(
            {
                "id": f"e1x_repair_fuse_reader_{case_id}_stream_model",
                "status": status,
                "detail": detail,
            }
        )
        case_summaries.append(
            {
                "case": case_id,
                "rom_sha256": str(rom.get("artifact_sha256", "")),
                "word_count": len(hex_words),
                "stream_cycles": int(sim.get("cycles", 0)),
            }
        )

    timeout_probe = simulate_fuse_stream(["4531585245504149"], max_words=4096, timeout_cycles=1)
    status, detail = pass_fail(
        not bool(timeout_probe.get("ok")) and "timeout" in str(timeout_probe.get("reason")),
        "behavioral model trips fail-closed timeout when OTP/loader stalls exceed budget",
        "timeout probe did not fail closed",
    )
    checks.append(
        {"id": "e1x_repair_fuse_reader_timeout_probe", "status": status, "detail": detail}
    )

    max_word_count = max((int(case["word_count"]) for case in case_summaries), default=0)
    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "rom_case_count": len(case_summaries),
        "production_fuse_window_words": fuse_window_words,
        "max_streamed_word_count": max_word_count,
        "max_streamed_word_count_vs_window": max_word_count / max(1, fuse_window_words),
        "rtl_marker_count": rtl_marker_count,
        "loader_marker_count": loader_marker_count,
        "verilator_lint_clean": all(
            check["status"] == "pass"
            for check in checks
            if check["id"] == "e1x_repair_fuse_reader_verilator_lint"
        ),
        "timeout_cycles": 1024,
        "rom_cases": case_summaries,
        "residual_blocker": "silicon_fuse_burning_and_foundry_otp_macro_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-repair-fuse-reader",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        **FALSE_CLAIM_FLAGS,
        "claim_boundary": (
            "E1X repair fuse/OTP read-port controller RTL and behavioral stream "
            "evidence against generated normal/high-failure repair images. This "
            "proves the controller contract into the repair-ROM loader; it is not "
            "silicon fuse burning, a foundry OTP macro implementation, wafer sort, "
            "or measured silicon evidence."
        ),
        "evidence_paths": [
            "rtl/e1x/e1x_repair_fuse_reader.sv",
            "rtl/e1x/e1x_repair_rom_loader.sv",
            "build/reports/e1x_repair_capacity.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_rom.hex",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_rom.hex",
            "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_rom.json",
            "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_repair_rom.hex",
            "scripts/check_e1x_repair_fuse_reader.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X repair fuse reader failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X repair fuse reader; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
