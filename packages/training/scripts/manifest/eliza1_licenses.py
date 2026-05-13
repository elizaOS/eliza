"""Eliza-1 bundle license attestations.

Single source of truth for the `licenses/` directory of every Eliza-1
bundle: which file maps to which upstream license, the SPDX id, the
upstream source repo/URL, the copyright holder, and the actual license
text to embed.

The publish orchestrator consumes this module to (a) write the
`licenses/` set + the `licenses/license-manifest.json` sidecar when
finalizing a bundle, and (b) refuse to publish a bundle whose
`licenses/` set is incomplete or whose embedded text does not match the
canonical SPDX text.

License texts live next to this module under `license_texts/`:

- `Apache-2.0.txt`        — the canonical Apache License 2.0
- `MIT-silero-vad.txt`    — the Silero VAD MIT license (with its
                            copyright line; the bare MIT body is the
                            same for omnivoice.cpp's MIT code clause)
- `CC-BY-NC-SA-4.0.txt`   — Creative Commons Attribution-NonCommercial-
                            ShareAlike 4.0 International legalcode

`base-v1` semantics (see `eliza1_manifest.py`): the shipped bytes are
the upstream BASE GGUFs, so the license for each component is the
*upstream component's* license, not a fresh "trained Eliza-1" license.
`LICENSE.eliza-1` is the project-level umbrella notice: the bundle as a
whole is governed by its most-restrictive component term (CC-BY-NC-SA-4.0
once the omnivoice-singing voice — which carries CC-BY-NC-SA training
lineage — is in the bundle), hence the non-commercial open-source
positioning in `packages/inference/AGENTS.md` §1.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Mapping, Sequence

_LICENSE_TEXTS_DIR: Final[Path] = Path(__file__).resolve().parent / "license_texts"


def _text(name: str) -> str:
    return (_LICENSE_TEXTS_DIR / name).read_text(encoding="utf-8")


# Lazy cache so importing this module does not eagerly read 30 KB of text.
_TEXT_CACHE: dict[str, str] = {}


def license_text(text_file: str) -> str:
    if text_file not in _TEXT_CACHE:
        _TEXT_CACHE[text_file] = _text(text_file)
    return _TEXT_CACHE[text_file]


@dataclass(frozen=True, slots=True)
class LicenseAttestation:
    """One `licenses/LICENSE.<component>` file.

    `bundle_file` is the destination filename inside `licenses/`.
    `spdx` is the SPDX identifier of the upstream license.
    `text_file` is the name of the canonical text under `license_texts/`.
    `upstream_repo` / `upstream_url` point at the source the bytes came
    from. `copyright_holder` is the named rights holder. `note` is a
    short human preamble prepended above the verbatim license text.
    """

    bundle_file: str
    component: str
    spdx: str
    text_file: str
    upstream_repo: str
    upstream_url: str
    copyright_holder: str
    note: str
    # Components present only in some tiers (vision -> mmproj tiers,
    # embedding -> non-lite, wakeword -> opt-in voice bundles).
    tiers: tuple[str, ...] | None = None

    def render(self) -> str:
        body = license_text(self.text_file)
        header = (
            f"Eliza-1 bundle license — {self.component}\n"
            f"SPDX-License-Identifier: {self.spdx}\n"
            f"Upstream: {self.upstream_repo} ({self.upstream_url})\n"
            f"Copyright: {self.copyright_holder}\n"
            "\n"
            f"{self.note}\n"
            "\n"
            "------------------------------------------------------------\n"
            "Verbatim upstream license text follows.\n"
            "------------------------------------------------------------\n"
            "\n"
        )
        return header + body


# The text backbone, the DFlash drafter (distilled from the text
# backbone) and the embedding model are all Apache-2.0 (Qwen3 family on
# HuggingFace ships the Apache-2.0 LICENSE). OmniVoice's GGUF repo
# (Serveurperso/OmniVoice-GGUF) and the omnivoice.cpp source both
# declare Apache-2.0 for the model weights; the C++ glue is MIT but is
# vendored into the llama.cpp build (a code dependency, not a shipped
# weight), so the *bundle* voice license is Apache-2.0. Qwen3-ASR is
# Apache-2.0. Silero VAD is MIT. openWakeWord code + feature models are
# Apache-2.0; the pre-trained wake-phrase head is CC-BY-NC-SA-4.0 (the
# bundle only ships the head as an opt-in experimental placeholder — see
# wakeword-head-plan.md).
_APACHE = "Apache-2.0.txt"
_MIT = "MIT-silero-vad.txt"
_CC_BY_NC_SA = "CC-BY-NC-SA-4.0.txt"

# Each entry's upstream is the *v1 source repo* recorded in
# ELIZA_1_RELEASE_ASSET_STATUS.md ("v1 source repos per tier /
# component"). Text tiers use the public Qwen3.5 0.8B / 1.7B / 4B line.
# ASR and embedding are deliberate upstream exceptions: they remain published
# Qwen3-ASR / Qwen3-Embedding artifacts rather than being rewritten as Qwen3.5.
ATTESTATIONS: Final[tuple[LicenseAttestation, ...]] = (
    LicenseAttestation(
        bundle_file="LICENSE.text",
        component="text backbone",
        spdx="Apache-2.0",
        text_file=_APACHE,
        upstream_repo="Qwen/Qwen3.5-0.8B / Qwen/Qwen3.5-2B / Qwen/Qwen3.5-4B (lineage recorded per tier in the manifest)",
        upstream_url="https://huggingface.co/Qwen/Qwen3.5-2B",
        copyright_holder="Alibaba Cloud (Qwen team) and contributors",
        note=(
            "The text weights in this bundle are derived from the Qwen3.5 family "
            "(GGUF-converted via the elizaOS/llama.cpp fork and Eliza-quantized), "
            "rebranded \"Eliza-1\" in user-facing strings per the project's "
            "branding policy. The upstream lineage and Apache-2.0 terms are "
            "recorded in eliza-1.manifest.json's lineage.text / provenance.sourceModels "
            "blocks."
        ),
    ),
    LicenseAttestation(
        bundle_file="LICENSE.voice",
        component="voice (OmniVoice TTS)",
        spdx="Apache-2.0",
        text_file=_APACHE,
        upstream_repo="Serveurperso/OmniVoice-GGUF; ServeurpersoCom/omnivoice.cpp",
        upstream_url="https://huggingface.co/Serveurperso/OmniVoice-GGUF",
        copyright_holder="the OmniVoice / omnivoice.cpp authors; Qwen-TTS lineage (Alibaba Cloud)",
        note=(
            "The TTS weights are OmniVoice (Qwen3-TTS lineage), staged from "
            "Serveurperso/OmniVoice-GGUF (declared Apache-2.0). The omnivoice.cpp "
            "C++ source fused into the llama.cpp build is MIT-licensed; that is a "
            "code dependency, not a shipped weight. The omnivoice-singing emotion / "
            "singing tag vocabulary inherits CC-BY-NC-SA training-data lineage "
            "(GTSinger / RAVDESS / Expresso) — acceptable for this non-commercial "
            "release; see LICENSE.eliza-1 for the bundle-level term."
        ),
    ),
    LicenseAttestation(
        bundle_file="LICENSE.asr",
        component="ASR (Qwen3-ASR)",
        spdx="Apache-2.0",
        text_file=_APACHE,
        upstream_repo="ggml-org/Qwen3-ASR-0.6B-GGUF / ggml-org/Qwen3-ASR-1.7B-GGUF (base: Qwen/Qwen3-ASR-0.6B / Qwen/Qwen3-ASR-1.7B)",
        upstream_url="https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF",
        copyright_holder="Alibaba Cloud (Qwen team) and contributors",
        note=(
            "ASR weights are Qwen3-ASR, GGUF-converted upstream. This is a "
            "deliberate Qwen3 upstream exception to the Qwen3.5 text-tier "
            "lineage; do not rewrite it as Qwen3.5. Declared upstream "
            "license: Apache-2.0."
        ),
    ),
    LicenseAttestation(
        bundle_file="LICENSE.vad",
        component="VAD (Silero VAD)",
        spdx="MIT",
        text_file=_MIT,
        upstream_repo=(
            "ggml-org/whisper-vad (native GGML Silero VAD v5.1.2); "
            "optional fallback: onnx-community/silero-vad (snakers4/silero-vad)"
        ),
        upstream_url="https://huggingface.co/ggml-org/whisper-vad",
        copyright_holder="Silero Team",
        note=(
            "Voice-activity detection model, shipped for native inference as "
            "the GGML artifact vad/silero-vad-v5.1.2.ggml.bin. Legacy bundles "
            "may also include the int8 ONNX fallback vad/silero-vad-int8.onnx. "
            "Drives barge-in cancellation and gates ASR past silent frames. "
            "Licensed MIT."
        ),
    ),
    LicenseAttestation(
        bundle_file="LICENSE.dflash",
        component="DFlash speculative-decode drafter",
        spdx="Apache-2.0",
        text_file=_APACHE,
        upstream_repo="elizaos/eliza-1/bundles/<tier> (distilled from the text backbone)",
        upstream_url="https://huggingface.co/elizaos",
        copyright_holder="elizaOS / Eliza Labs (drafter); Alibaba Cloud (Qwen team) (text lineage)",
        note=(
            "The DFlash drafter is a small student model aligned to the Eliza-1 "
            "text checkpoint (target sha256 recorded in dflash/target-meta.json). "
            "It inherits the text backbone's Apache-2.0 lineage. The DFlash "
            "speculative-decoding method is open research (see "
            "packages/inference/AGENTS.md §3). Speculative decoding is mandatory "
            "in the Eliza-1 runtime, not optional."
        ),
    ),
    LicenseAttestation(
        bundle_file="LICENSE.embedding",
        component="embedding (Qwen3-Embedding)",
        spdx="Apache-2.0",
        text_file=_APACHE,
        upstream_repo="Qwen/Qwen3-Embedding-0.6B-GGUF",
        upstream_url="https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF",
        copyright_holder="Alibaba Cloud (Qwen team) and contributors",
        note=(
            "Qwen3-Embedding-0.6B (1024-dim, Matryoshka, 32k ctx), shipped as a "
            "separate embedding/ artifact on non-lite tiers. On 0_8b the embedding "
            "model IS the text backbone with --pooling last — no duplicate weights, "
            "no separate embedding/ artifact, and this file is absent on 0_8b. "
            "Declared upstream license: Apache-2.0."
        ),
        tiers=("4b",),
    ),
    LicenseAttestation(
        bundle_file="LICENSE.vision",
        component="vision (mmproj projector)",
        spdx="Apache-2.0",
        text_file=_APACHE,
        upstream_repo="unsloth/Qwen3.5-4B-GGUF (mmproj-F16.gguf)",
        upstream_url="https://huggingface.co/unsloth/Qwen3.5-4B-GGUF",
        copyright_holder="Alibaba Cloud (Qwen team) and contributors",
        note=(
            "The vision projector (mmproj) is part of the Qwen3.5 multimodal "
            "lineage; present only on the mmproj-capable 4B tier where it is "
            "not inlined into the text GGUF. Declared "
            "upstream license: Apache-2.0."
        ),
        tiers=("4b",),
    ),
    LicenseAttestation(
        bundle_file="LICENSE.wakeword",
        component="wake word (openWakeWord)",
        spdx="Apache-2.0 (code/feature models) WITH CC-BY-NC-SA-4.0 (pre-trained head)",
        text_file=_APACHE,
        upstream_repo="dscripka/openWakeWord (v0.5.1)",
        upstream_url="https://github.com/dscripka/openWakeWord",
        copyright_holder="David Scripka and contributors (openWakeWord)",
        note=(
            "openWakeWord code and the shared feature models (melspectrogram, "
            "embedding) are Apache-2.0 (text below). The PRE-TRAINED wake-phrase "
            "head shipped in this bundle is the upstream \"hey jarvis\" placeholder "
            "head, which carries CC-BY-NC-SA-4.0 training-corpus lineage "
            "(GTSinger / RAVDESS / Expresso-style data). Acceptable for the "
            "non-commercial Eliza-1 release. The placeholder head is OPT-IN, "
            "DISABLED by default, and surfaced with a \"placeholder phrase\" "
            "warning; a head trained on the approved Eliza-1 wake phrase ships "
            "later (see packages/inference/reports/porting/2026-05-11/"
            "wakeword-head-plan.md). For any commercial pivot the head must be "
            "retrained on a commercially-licensed corpus. CC-BY-NC-SA-4.0 "
            "legalcode: https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode"
        ),
    ),
    LicenseAttestation(
        bundle_file="LICENSE.eliza-1",
        component="Eliza-1 bundle (umbrella)",
        spdx="CC-BY-NC-SA-4.0",
        text_file=_CC_BY_NC_SA,
        upstream_repo="elizaos/eliza-1/bundles/<tier>",
        upstream_url="https://huggingface.co/elizaos",
        copyright_holder="elizaOS / Eliza Labs and the upstream component authors (see per-component LICENSE.* files)",
        note=(
            "Eliza-1 is a non-commercial open-source on-device model line. This "
            "bundle is composed of components under permissive (Apache-2.0 / MIT) "
            "and CC-compatible terms; see the per-component LICENSE.* files and the "
            "manifest lineage / provenance blocks for the full breakdown. Because "
            "the bundle includes the omnivoice-singing voice (whose training-data "
            "lineage is CC-BY-NC-SA), the BUNDLE AS A WHOLE is governed by the "
            "most-restrictive component term, CC-BY-NC-SA-4.0 (verbatim legalcode "
            "below): you may use, share, and adapt it for NON-COMMERCIAL purposes "
            "with attribution and ShareAlike. Individual permissively-licensed "
            "components remain usable under their own (less restrictive) terms — "
            "see their LICENSE.* file. If the project pivots to commercial "
            "licensing, the CC-BY-NC-SA voice training-data lineage (GTSinger / "
            "RAVDESS / Expresso) must be re-evaluated and likely re-trained on "
            "commercially-licensed corpora."
        ),
    ),
)


_ATTESTATION_BY_FILE: Final[Mapping[str, LicenseAttestation]] = {
    a.bundle_file: a for a in ATTESTATIONS
}


def attestations_for_components(components: Sequence[str]) -> tuple[LicenseAttestation, ...]:
    """The license attestations a bundle with `components` must ship.

    `components` is the set of component-kind names actually present in
    the bundle (e.g. {"text", "voice", "asr", "vad", "dflash",
    "embedding", "vision", "wakeword"}). LICENSE.text / LICENSE.voice /
    LICENSE.dflash / LICENSE.eliza-1 are always required. The rest are
    conditional on the component being present.
    """

    required_always = {"LICENSE.text", "LICENSE.voice", "LICENSE.dflash", "LICENSE.eliza-1"}
    conditional = {
        "asr": "LICENSE.asr",
        "vad": "LICENSE.vad",
        "embedding": "LICENSE.embedding",
        "vision": "LICENSE.vision",
        "wakeword": "LICENSE.wakeword",
    }
    wanted: list[str] = [a.bundle_file for a in ATTESTATIONS if a.bundle_file in required_always]
    comp_set = set(components)
    for comp, fname in conditional.items():
        if comp in comp_set:
            wanted.append(fname)
    # Preserve declaration order, dedupe.
    seen: set[str] = set()
    out: list[LicenseAttestation] = []
    for a in ATTESTATIONS:
        if a.bundle_file in wanted and a.bundle_file not in seen:
            seen.add(a.bundle_file)
            out.append(a)
    return tuple(out)


def license_manifest_sidecar(
    attestations: Sequence[LicenseAttestation],
) -> dict[str, object]:
    """The `licenses/license-manifest.json` payload.

    Maps each shipped `LICENSE.<component>` file → upstream license SPDX
    id + source repo + URL + copyright holder. The publish orchestrator
    writes this and the manifest builder may surface it.
    """

    return {
        "$schema": "https://elizaos.ai/schemas/eliza-1.license-manifest.v1.json",
        "schemaVersion": 1,
        "note": (
            "Per-component license map for this Eliza-1 bundle. The bundle as a "
            "whole is governed by its most-restrictive component term "
            "(CC-BY-NC-SA-4.0). Each LICENSE.<component> file embeds the verbatim "
            "upstream license text. See packages/training/scripts/manifest/"
            "eliza1_licenses.py."
        ),
        "bundleSpdx": "CC-BY-NC-SA-4.0",
        "components": [
            {
                "file": f"licenses/{a.bundle_file}",
                "component": a.component,
                "spdx": a.spdx,
                "upstreamRepo": a.upstream_repo,
                "upstreamUrl": a.upstream_url,
                "copyright": a.copyright_holder,
            }
            for a in attestations
        ],
    }


def write_bundle_licenses(
    licenses_dir: Path, components: Sequence[str]
) -> tuple[list[str], dict[str, object]]:
    """Write the `licenses/` set + sidecar for a bundle.

    Returns `(written_relpaths, sidecar_dict)`. Idempotent: rewrites the
    files unconditionally so a stale stub gets replaced with the real
    text.
    """

    licenses_dir.mkdir(parents=True, exist_ok=True)
    attestations = attestations_for_components(components)
    written: list[str] = []
    for a in attestations:
        path = licenses_dir / a.bundle_file
        path.write_text(a.render(), encoding="utf-8")
        written.append(f"licenses/{a.bundle_file}")
    sidecar = license_manifest_sidecar(attestations)
    sidecar_path = licenses_dir / "license-manifest.json"
    sidecar_path.write_text(json.dumps(sidecar, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    written.append("licenses/license-manifest.json")
    return written, sidecar


def verify_bundle_licenses(
    licenses_dir: Path, components: Sequence[str]
) -> list[str]:
    """Return a list of problems with a bundle's `licenses/` set.

    Empty list == OK. Checks: every required file present, non-empty,
    embeds the canonical SPDX text body, and the sidecar agrees.
    """

    problems: list[str] = []
    attestations = attestations_for_components(components)
    for a in attestations:
        path = licenses_dir / a.bundle_file
        if not path.is_file():
            problems.append(f"missing license file licenses/{a.bundle_file}")
            continue
        text = path.read_text(encoding="utf-8")
        if not text.strip():
            problems.append(f"empty license file licenses/{a.bundle_file}")
            continue
        canonical = license_text(a.text_file).strip()
        # The canonical body must appear verbatim somewhere in the file
        # (after the Eliza-1 header preamble).
        if canonical not in text:
            problems.append(
                f"licenses/{a.bundle_file} does not embed the verbatim "
                f"{a.spdx} text ({a.text_file})"
            )
        if f"SPDX-License-Identifier: {a.spdx}" not in text:
            problems.append(
                f"licenses/{a.bundle_file} missing 'SPDX-License-Identifier: {a.spdx}' header"
            )
    sidecar_path = licenses_dir / "license-manifest.json"
    if not sidecar_path.is_file():
        problems.append("missing licenses/license-manifest.json sidecar")
    else:
        try:
            sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            problems.append(f"licenses/license-manifest.json: invalid JSON: {exc}")
        else:
            expected = license_manifest_sidecar(attestations)
            if sidecar.get("components") != expected["components"]:
                problems.append(
                    "licenses/license-manifest.json components do not match the "
                    "expected per-component map for this bundle's components"
                )
            if sidecar.get("bundleSpdx") != "CC-BY-NC-SA-4.0":
                problems.append(
                    "licenses/license-manifest.json bundleSpdx must be CC-BY-NC-SA-4.0"
                )
    return problems


def _detect_components(bundle_dir: Path) -> list[str]:
    """Infer which component kinds a bundle directory contains.

    text/voice/asr/vad/dflash are always present in a §2 bundle; vision/
    embedding/wakeword are tier-dependent (detected from the
    corresponding subdir / file).
    """

    components = ["text", "voice", "asr", "vad", "dflash"]
    if (bundle_dir / "vision").is_dir() and any((bundle_dir / "vision").iterdir()):
        components.append("vision")
    if (bundle_dir / "embedding").is_dir() and any((bundle_dir / "embedding").iterdir()):
        components.append("embedding")
    # An existing LICENSE.embedding implies the tier ships the embedding
    # component even if the weights subdir hasn't been staged yet.
    if (bundle_dir / "licenses" / "LICENSE.embedding").is_file() and "embedding" not in components:
        components.append("embedding")
    if (bundle_dir / "licenses" / "LICENSE.wakeword").is_file() or (
        bundle_dir / "wakeword"
    ).is_dir():
        components.append("wakeword")
    return components


def main(argv: Sequence[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="Write/verify the licenses/ set for an Eliza-1 bundle."
    )
    parser.add_argument("bundle_dir", type=Path, help="path to the bundle root")
    parser.add_argument(
        "--components",
        nargs="*",
        default=None,
        help="component kinds present (default: detect from the bundle dir)",
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="verify the licenses/ set instead of writing it",
    )
    args = parser.parse_args(argv)

    bundle_dir: Path = args.bundle_dir
    components = args.components or _detect_components(bundle_dir)
    licenses_dir = bundle_dir / "licenses"

    if args.verify_only:
        problems = verify_bundle_licenses(licenses_dir, components)
        if problems:
            for p in problems:
                print(f"FAIL: {p}")
            return 1
        print(f"OK: licenses/ set complete for components {components}")
        return 0

    written, _ = write_bundle_licenses(licenses_dir, components)
    for rel in written:
        print(f"wrote {rel}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
