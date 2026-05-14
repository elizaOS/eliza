"""Apply GGUF Q8_0 quantization to a fine-tuned Qwen checkpoint.

This is the high-quality llama.cpp export in the Eliza-1 release ladder. It
uses the same converter and load-smoke path as the Q4_K_M/Q6_K wrappers, then
runs ``llama-quantize`` with ``Q8_0`` so the publish pipeline can ship a
near-lossless GGUF alongside the smaller K-quants.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import logging
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def _load_kquant_helpers():
    helper_path = _HERE / "gguf-q4_k_m_apply.py"
    spec = importlib.util.spec_from_file_location("gguf_q4_k_m_apply", helper_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load GGUF helper from {helper_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


_helpers = _load_kquant_helpers()
write_sidecar = _helpers.write_sidecar

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger("gguf_q8_0_apply")

QUANT_LEVEL = "Q8_0"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    ap.add_argument(
        "--model",
        required=True,
        help="HF repo id or local path to a HuggingFace causal-LM checkpoint.",
    )
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument(
        "--calibration",
        type=Path,
        default=None,
        help=(
            "Optional importance-matrix calibration file or JSONL of prompts. "
            "Only *.imatrix files are forwarded to llama-quantize; JSONL is "
            "accepted for CLI parity with the other quantization scripts."
        ),
    )
    ap.add_argument("--calibration-samples", type=int, default=128)
    ap.add_argument(
        "--llama-cpp-dir",
        type=Path,
        default=None,
        help="Path to a llama.cpp checkout (overrides PATH lookup).",
    )
    ap.add_argument(
        "--keep-f16",
        action="store_true",
        help="Keep the intermediate f16 GGUF in --output (default: delete it).",
    )
    ap.add_argument(
        "--no-smoke-load",
        dest="smoke_load",
        action="store_false",
        help="Skip the post-quantize llama-cli load-smoke.",
    )
    ap.set_defaults(smoke_load=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    if args.dry_run:
        print(json.dumps({**vars(args), "quant_level": QUANT_LEVEL}, indent=2, default=str))
        return 0

    convert = _helpers._find_convert_script(args.llama_cpp_dir)
    quantize = _helpers._find_quantize_binary(args.llama_cpp_dir)

    args.output.mkdir(parents=True, exist_ok=True)
    _helpers.QUANT_LEVEL = QUANT_LEVEL
    basename = _helpers._resolve_output_basename(str(args.model), args.output)
    f16_path = args.output / basename.replace(f"-{QUANT_LEVEL}.gguf", "-F16.gguf")
    quant_path = args.output / basename

    log.info("step 1/2: convert HF -> f16 GGUF (%s)", f16_path)
    _helpers._run(
        [
            sys.executable,
            convert,
            str(args.model),
            "--outtype",
            "f16",
            "--outfile",
            str(f16_path),
        ]
    )

    log.info("step 2/2: llama-quantize -> %s (%s)", QUANT_LEVEL, quant_path)
    quantize_cmd: list[str | Path] = [quantize]
    if args.calibration is not None and args.calibration.suffix == ".imatrix":
        quantize_cmd.extend(["--imatrix", str(args.calibration)])
    quantize_cmd.extend([str(f16_path), str(quant_path), QUANT_LEVEL])
    _helpers._run(quantize_cmd)

    if not args.keep_f16:
        log.info("removing intermediate %s", f16_path)
        f16_path.unlink(missing_ok=True)

    smoke: dict[str, object] | None = None
    if args.smoke_load:
        smoke = _helpers._smoke_load_gguf(quant_path, quantize)
        if smoke.get("ok"):
            log.info("load-smoke OK: %r", str(smoke.get("output", ""))[:80])
        else:
            log.warning("load-smoke FAILED: %s", smoke.get("error"))

    sidecar = {
        "method": "gguf_q8_0",
        "scheme": QUANT_LEVEL,
        "tool": "llama.cpp/convert_hf_to_gguf.py + llama-quantize",
        "convert_script": str(convert),
        "quantize_binary": str(quantize),
        "source_model": str(args.model),
        "output_file": str(quant_path),
        "imatrix": str(args.calibration)
        if args.calibration and args.calibration.suffix == ".imatrix"
        else None,
        "smoke_load": smoke,
        "notes": (
            "Q8_0 is the high-quality GGUF export in the Eliza-1 ladder. "
            "It is larger than K-quants but useful as a near-lossless local "
            "reference and as a source for downstream quantizer comparisons."
        ),
    }
    sidecar_path = write_sidecar(args.output, "gguf_q8_0.json", sidecar)
    log.info("wrote %s", sidecar_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
