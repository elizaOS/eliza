#!/usr/bin/env python3
"""Cuttlefish riscv64 Eliza agent smoke driver.

Runs after a live CVD is available on adb (i.e. after `capture-aosp-evidence.sh
... cuttlefish-smoke` has booted the virtual device). Drives the on-device
Eliza agent through the gates D.5--D.13 from the AOSP simulator completion
audit:

  * agent service alive (pidof <package> returns non-empty)
  * /api/agent/self-status HTTP 200 with `agentId` shape and per-plugin
    `status:"ready"` on the local-inference plugin set
  * llama smoke produces >= AOSP_AGENT_LLAMA_MIN_TOKENS tokens within the
    600s budget; the wall-clock seconds are emitted as LLAMA_WALL_S
  * Kokoro TTS produces a valid RIFF/WAVE WAV and emits TTS_SAMPLES
  * Whisper STT reaches >= AOSP_AGENT_STT_MIN_OVERLAP token-overlap on the
    golden transcript
  * Wakeword-cpp detection fires on the wakeword stimulus
  * Silero VAD returns one or more speech segments on the speech+silence
    fixture
  * (optional, opt-in) stable-diffusion sample is a valid PNG

Every assertion is written as a `KEY=value` line on stdout so the parent
capture-aosp-evidence.sh wrapper can store them in the evidence log along
with the standard provenance metadata (`EXTERNAL_TREE=`, `START_UTC=`,
`RESULT=`, `eliza-evidence: status=PASS|FAIL`, etc.).

This script preserves the existing `claim_boundary` semantics for the
cuttlefish smoke evidence: it makes no Android boot or compatibility
claim. It is virtual-device smoke evidence only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None:
        raise SystemExit(f"error: required environment variable {name} is unset")
    return value


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return int(raw)


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return float(raw)


def adb_args(serial: str) -> list[str]:
    if serial:
        return ["adb", "-s", serial]
    return ["adb"]


def run(
    cmd: list[str], *, check: bool = True, capture: bool = False
) -> subprocess.CompletedProcess:
    print(f"==> {' '.join(shlex.quote(c) for c in cmd)}", flush=True)
    return subprocess.run(
        cmd,
        check=check,
        text=True,
        capture_output=capture,
    )


def adb_shell(serial: str, *args: str, capture: bool = True) -> str:
    result = run(adb_args(serial) + ["shell", *args], capture=capture, check=True)
    return (result.stdout or "").replace("\r", "").strip()


def http_post_json(url: str, payload: dict, *, timeout: int = 120) -> tuple[int, bytes]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.getcode(), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def http_get(url: str, *, timeout: int = 30) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.getcode(), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except urllib.error.URLError:
        return 0, b""


def wait_for(predicate, *, timeout: int, interval: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def token_overlap(hyp: str, ref: str) -> float:
    def tok(s: str) -> set[str]:
        return set(re.findall(r"[a-z0-9]+", s.lower()))

    H, R = tok(hyp), tok(ref)
    if not R:
        return 0.0
    return len(H & R) / len(R)


def wav_sample_count(path: Path) -> int:
    """Return the per-channel sample count of a canonical RIFF/WAVE PCM file.

    We avoid taking a soundfile/numpy dependency: the Python stdlib `wave`
    module is enough for the sample counts we need for the smoke evidence.
    """
    import wave

    with wave.open(str(path), "rb") as handle:
        return handle.getnframes()


def assert_riff_wave(path: Path) -> str:
    result = subprocess.run(
        ["file", str(path)],
        text=True,
        capture_output=True,
        check=True,
    )
    description = result.stdout.strip()
    if "RIFF" not in description or "WAVE" not in description:
        raise SystemExit(f"error: {path} is not a valid RIFF/WAVE file: {description}")
    return description


def assert_png(path: Path) -> str:
    result = subprocess.run(
        ["file", str(path)],
        text=True,
        capture_output=True,
        check=True,
    )
    description = result.stdout.strip()
    if "PNG image" not in description:
        raise SystemExit(f"error: {path} is not a valid PNG image: {description}")
    return description


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--out-dir",
        default="out",
        help="Directory under the AOSP tree to write JSON bodies and forensic sidecars.",
    )
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    serial = os.environ.get("AOSP_ADB_SERIAL", "")
    apk = Path(env("AOSP_AGENT_APK"))
    package = env("AOSP_AGENT_PACKAGE", "com.elizaos.agent")
    service = env("AOSP_AGENT_SERVICE", "com.elizaos.agent/.AgentService")
    host_port = env_int("AOSP_AGENT_HOST_PORT", 31337)
    device_port = env_int("AOSP_AGENT_DEVICE_PORT", 31337)
    service_wait = env_int("AOSP_AGENT_SERVICE_WAIT_SECONDS", 90)
    port_wait = env_int("AOSP_AGENT_PORT_WAIT_SECONDS", 60)
    llama_model = Path(env("AOSP_AGENT_LLAMA_MODEL"))
    device_dir = env("AOSP_AGENT_LLAMA_DEVICE_DIR", "/data/local/tmp/eliza-smoke")
    llama_prompt = env("AOSP_AGENT_LLAMA_PROMPT", "Say hello in one short sentence.")
    llama_min_tokens = env_int("AOSP_AGENT_LLAMA_MIN_TOKENS", 32)
    tts_text = env("AOSP_AGENT_TTS_TEXT", "The quick brown fox jumps over the lazy dog.")
    golden_audio = Path(env("AOSP_AGENT_GOLDEN_AUDIO"))
    golden_transcript_text = env("AOSP_AGENT_GOLDEN_TRANSCRIPT")
    stt_min_overlap = env_float("AOSP_AGENT_STT_MIN_OVERLAP", 0.80)
    sd_optin = os.environ.get("AOSP_AGENT_SD_OPTIN", "0") == "1"
    sd_prompt = env("AOSP_AGENT_SD_PROMPT", "a single red apple on a white background")
    wakeword_model = Path(env("AOSP_AGENT_WAKEWORD_MODEL"))
    wakeword_audio = Path(env("AOSP_AGENT_WAKEWORD_AUDIO"))
    vad_audio = Path(env("AOSP_AGENT_VAD_AUDIO"))
    required_plugins_raw = env(
        "AOSP_AGENT_REQUIRED_PLUGINS",
        "local-inference",
    )
    required_plugins = [p.strip() for p in required_plugins_raw.split(",") if p.strip()]

    for path, label in (
        (apk, "AOSP_AGENT_APK"),
        (llama_model, "AOSP_AGENT_LLAMA_MODEL"),
        (golden_audio, "AOSP_AGENT_GOLDEN_AUDIO"),
        (wakeword_model, "AOSP_AGENT_WAKEWORD_MODEL"),
        (wakeword_audio, "AOSP_AGENT_WAKEWORD_AUDIO"),
        (vad_audio, "AOSP_AGENT_VAD_AUDIO"),
    ):
        if not path.is_file():
            raise SystemExit(f"error: {label} path does not exist: {path}")

    print(f"AGENT_APK={apk}")
    print(f"AGENT_PACKAGE={package}")
    print(f"AGENT_SERVICE={service}")
    print(f"AGENT_HOST_PORT={host_port}")
    print(f"AGENT_DEVICE_PORT={device_port}")
    print(f"AGENT_LLAMA_MIN_TOKENS={llama_min_tokens}")
    print(f"AGENT_STT_MIN_OVERLAP={stt_min_overlap:.2f}")
    print(f"AGENT_SD_OPTIN={'1' if sd_optin else '0'}")

    # ABI guard.
    abi = adb_shell(serial, "getprop", "ro.product.cpu.abi")
    print(f"ro.product.cpu.abi={abi}")
    if abi != "riscv64":
        raise SystemExit(f"error: device ABI is {abi!r}, expected riscv64")

    # APK riscv64 jniLibs guard before install (cheap; avoids
    # INSTALL_FAILED_NO_MATCHING_ABIS in a way the operator can triage).
    unzip_listing = subprocess.run(
        ["unzip", "-l", str(apk)],
        text=True,
        capture_output=True,
        check=True,
    ).stdout
    if "lib/riscv64/" not in unzip_listing:
        raise SystemExit(
            f"error: {apk} has no lib/riscv64/ payload; check jniLibs/riscv64/ staging"
        )

    abilist = adb_shell(serial, "getprop", "ro.product.cpu.abilist")
    print(f"ro.product.cpu.abilist={abilist}")

    # Install APK with runtime permissions granted (-g auto-grants).
    install_result = subprocess.run(
        adb_args(serial) + ["install", "-r", "-g", str(apk)],
        text=True,
        capture_output=True,
        check=False,
    )
    install_combined = (install_result.stdout or "") + (install_result.stderr or "")
    print(install_combined.strip())
    if install_result.returncode != 0 or "INSTALL_FAILED" in install_combined:
        print(f"INSTALL_RC={install_result.returncode}")
        print(f"DEVICE_ABILIST={abilist}")
        print("APK_NATIVE_LIBS=")
        for line in unzip_listing.splitlines():
            if "lib/" in line:
                print(f"APK_NATIVE_LIBS_ENTRY={line.strip()}")
        raise SystemExit(
            f"error: adb install failed (rc={install_result.returncode}): {install_combined.strip()}"
        )

    pm_list = adb_shell(serial, "pm", "list", "packages", package)
    if package not in pm_list:
        raise SystemExit(
            f"error: package {package} not present after install; pm list output: {pm_list!r}"
        )
    print(f"APK_INSTALLED={package}")

    # Stage model + golden fixtures.
    run(adb_args(serial) + ["shell", "mkdir", "-p", device_dir])
    run(adb_args(serial) + ["push", str(llama_model), f"{device_dir}/llama.gguf"])
    run(adb_args(serial) + ["push", str(golden_audio), f"{device_dir}/golden.wav"])
    run(adb_args(serial) + ["push", str(wakeword_model), f"{device_dir}/wakeword.gguf"])
    run(adb_args(serial) + ["push", str(wakeword_audio), f"{device_dir}/wakeword.wav"])
    run(adb_args(serial) + ["push", str(vad_audio), f"{device_dir}/vad.wav"])

    golden_transcript_path = out_dir / "eliza-cuttlefish-agent-golden-transcript.txt"
    golden_transcript_path.write_text(golden_transcript_text)
    run(adb_args(serial) + ["push", str(golden_transcript_path), f"{device_dir}/golden.txt"])

    # Start the foreground service.
    run(adb_args(serial) + ["shell", "am", "start-foreground-service", service])

    # Wait for pidof to return non-empty.
    def agent_alive() -> bool:
        pid = adb_shell(serial, "pidof", package)
        return bool(pid.strip())

    if not wait_for(agent_alive, timeout=service_wait):
        print("AGENT_SERVICE=dead")
        raise SystemExit(f"error: agent service {service} did not start within {service_wait}s")
    agent_pid = adb_shell(serial, "pidof", package).split()[0]
    print(f"AGENT_PID={agent_pid}")
    print("AGENT_SERVICE=alive")

    # Forward host port to device port for HTTP probes.
    run(adb_args(serial) + ["forward", f"tcp:{host_port}", f"tcp:{device_port}"])

    base_url = f"http://127.0.0.1:{host_port}"

    # Wait for /api/agent/self-status to return HTTP 200.
    self_status_url = f"{base_url}/api/agent/self-status"
    self_status_body_path = out_dir / "eliza-cuttlefish-agent-self-status.json"
    last_code = 0
    last_body = b""

    def self_status_ok() -> bool:
        nonlocal last_code, last_body
        last_code, last_body = http_get(self_status_url, timeout=10)
        return last_code == 200

    if not wait_for(self_status_ok, timeout=port_wait):
        print(f"SELF_STATUS_HTTP={last_code}")
        raise SystemExit(
            f"error: /api/agent/self-status returned HTTP {last_code} (waited {port_wait}s)"
        )
    self_status_body_path.write_bytes(last_body)
    print(f"SELF_STATUS_HTTP={last_code}")

    self_status_payload = json.loads(last_body.decode("utf-8"))
    if not isinstance(self_status_payload, dict) or "agentId" not in self_status_payload:
        raise SystemExit(
            f"error: /api/agent/self-status body missing agentId: {self_status_payload!r}"
        )
    print("SELF_STATUS_JSON_SHAPE=ok")

    plugins = self_status_payload.get("plugins")
    if not isinstance(plugins, list):
        raise SystemExit(
            f"error: /api/agent/self-status missing plugins[]: {self_status_payload!r}"
        )
    plugin_by_name: dict[str, dict] = {}
    for entry in plugins:
        if isinstance(entry, dict):
            name = entry.get("name") or entry.get("id")
            if isinstance(name, str):
                plugin_by_name[name] = entry
        elif isinstance(entry, str):
            plugin_by_name[entry] = {"name": entry, "status": "ready"}
    print(f"SELF_STATUS_PLUGINS={','.join(sorted(plugin_by_name))}")
    for required_plugin in required_plugins:
        entry = plugin_by_name.get(required_plugin)
        if entry is None:
            raise SystemExit(
                f"error: required plugin {required_plugin!r} missing from /api/agent/self-status"
            )
        status = entry.get("status") if isinstance(entry, dict) else None
        if status != "ready":
            raise SystemExit(
                f"error: plugin {required_plugin!r} status is {status!r}, expected 'ready'"
            )
    print(f"SELF_STATUS_REQUIRED_PLUGINS_READY={','.join(required_plugins)}")

    # Llama smoke.
    llama_body_path = out_dir / "eliza-cuttlefish-agent-llama.json"
    llama_url = f"{base_url}/api/agent/llama"
    llama_start = time.monotonic()
    llama_http, llama_raw = http_post_json(
        llama_url,
        {
            "model": f"{device_dir}/llama.gguf",
            "prompt": llama_prompt,
            "min_tokens": llama_min_tokens,
        },
        timeout=600,
    )
    llama_wall_s = time.monotonic() - llama_start
    llama_body_path.write_bytes(llama_raw)
    print(f"LLAMA_HTTP={llama_http}")
    print(f"LLAMA_WALL_S={llama_wall_s:.2f}")
    if llama_http != 200:
        raise SystemExit(f"error: llama smoke returned HTTP {llama_http}")
    llama_payload = json.loads(llama_raw.decode("utf-8"))
    tokens = llama_payload.get("tokens")
    if isinstance(tokens, list):
        token_count = len(tokens)
    else:
        token_count = int(llama_payload.get("token_count", 0))
    print(f"LLAMA_TOKENS={token_count}")
    if token_count >= llama_min_tokens:
        print("LLAMA_TOKENS_GE_32=true")
    else:
        print("LLAMA_TOKENS_GE_32=false")
        raise SystemExit(f"error: llama produced {token_count} tokens (< {llama_min_tokens})")

    # Kokoro TTS smoke.
    tts_body_path = out_dir / "eliza-cuttlefish-agent-tts.json"
    tts_url = f"{base_url}/api/agent/tts"
    device_tts_path = f"{device_dir}/tts.wav"
    tts_http, tts_raw = http_post_json(
        tts_url,
        {"text": tts_text, "out_path": device_tts_path},
        timeout=600,
    )
    tts_body_path.write_bytes(tts_raw)
    print(f"TTS_HTTP={tts_http}")
    if tts_http != 200:
        raise SystemExit(f"error: TTS smoke returned HTTP {tts_http}")

    local_tts_wav = out_dir / "eliza-cuttlefish-agent-tts.wav"
    run(adb_args(serial) + ["pull", device_tts_path, str(local_tts_wav)])
    tts_file = assert_riff_wave(local_tts_wav)
    print(f"TTS_FILE={tts_file}")
    tts_samples = wav_sample_count(local_tts_wav)
    print(f"TTS_SAMPLES={tts_samples}")
    if tts_samples <= 0:
        raise SystemExit(f"error: TTS WAV has no samples: {local_tts_wav}")
    print("TTS_WAV=ok")

    # Whisper STT smoke.
    stt_body_path = out_dir / "eliza-cuttlefish-agent-stt.json"
    stt_url = f"{base_url}/api/agent/stt"
    stt_http, stt_raw = http_post_json(
        stt_url,
        {"in_path": f"{device_dir}/golden.wav"},
        timeout=600,
    )
    stt_body_path.write_bytes(stt_raw)
    print(f"STT_HTTP={stt_http}")
    if stt_http != 200:
        raise SystemExit(f"error: STT smoke returned HTTP {stt_http}")
    stt_payload = json.loads(stt_raw.decode("utf-8"))
    hyp = stt_payload.get("text") or stt_payload.get("transcript") or ""
    overlap = token_overlap(hyp, golden_transcript_text)
    print(f"STT_OVERLAP={overlap:.2f}")
    if overlap >= stt_min_overlap:
        print("STT_OVERLAP_GE_0_80=true")
    else:
        print("STT_OVERLAP_GE_0_80=false")
        raise SystemExit(f"error: STT token-overlap {overlap:.2f} < {stt_min_overlap:.2f}")

    # Wakeword-cpp smoke.
    wakeword_body_path = out_dir / "eliza-cuttlefish-agent-wakeword.json"
    wakeword_url = f"{base_url}/api/agent/wakeword"
    wakeword_http, wakeword_raw = http_post_json(
        wakeword_url,
        {
            "model": f"{device_dir}/wakeword.gguf",
            "in_path": f"{device_dir}/wakeword.wav",
        },
        timeout=300,
    )
    wakeword_body_path.write_bytes(wakeword_raw)
    print(f"WAKEWORD_HTTP={wakeword_http}")
    if wakeword_http != 200:
        raise SystemExit(f"error: wakeword smoke returned HTTP {wakeword_http}")
    wakeword_payload = json.loads(wakeword_raw.decode("utf-8"))
    detected = bool(wakeword_payload.get("detected"))
    print(f"WAKEWORD_DETECTED={'true' if detected else 'false'}")
    if not detected:
        raise SystemExit("error: wakeword did not fire on the stimulus fixture")

    # Silero VAD smoke.
    vad_body_path = out_dir / "eliza-cuttlefish-agent-vad.json"
    vad_url = f"{base_url}/api/agent/vad"
    vad_http, vad_raw = http_post_json(
        vad_url,
        {"in_path": f"{device_dir}/vad.wav"},
        timeout=300,
    )
    vad_body_path.write_bytes(vad_raw)
    print(f"VAD_HTTP={vad_http}")
    if vad_http != 200:
        raise SystemExit(f"error: VAD smoke returned HTTP {vad_http}")
    vad_payload = json.loads(vad_raw.decode("utf-8"))
    vad_segments = vad_payload.get("segments")
    if not isinstance(vad_segments, list):
        raise SystemExit(f"error: VAD body missing segments[]: {vad_payload!r}")
    print(f"VAD_SEGMENTS={len(vad_segments)}")
    if len(vad_segments) <= 0:
        raise SystemExit("error: VAD returned zero segments on speech+silence fixture")

    # Optional stable-diffusion smoke.
    if sd_optin:
        sd_body_path = out_dir / "eliza-cuttlefish-agent-sd.json"
        sd_url = f"{base_url}/api/agent/sd"
        device_sd_path = f"{device_dir}/sd.png"
        sd_http, sd_raw = http_post_json(
            sd_url,
            {"prompt": sd_prompt, "out_path": device_sd_path},
            timeout=1800,
        )
        sd_body_path.write_bytes(sd_raw)
        print(f"SD_HTTP={sd_http}")
        if sd_http != 200:
            raise SystemExit(f"error: SD smoke returned HTTP {sd_http}")
        local_sd_png = out_dir / "eliza-cuttlefish-agent-sd.png"
        run(adb_args(serial) + ["pull", device_sd_path, str(local_sd_png)])
        sd_file = assert_png(local_sd_png)
        print(f"SD_FILE={sd_file}")
        print("SD_SAMPLE=ok")
    else:
        print("SD_SAMPLE=skipped_optin")

    # Self-status final check: every required plugin must still be ready after
    # the workload has run. This catches plugins that crashed during inference
    # but kept the foreground service alive.
    final_status_path = out_dir / "eliza-cuttlefish-agent-self-status-final.json"
    final_code, final_body = http_get(self_status_url, timeout=30)
    final_status_path.write_bytes(final_body)
    print(f"SELF_STATUS_FINAL_HTTP={final_code}")
    if final_code != 200:
        raise SystemExit(f"error: final /api/agent/self-status returned HTTP {final_code}")
    final_payload = json.loads(final_body.decode("utf-8"))
    final_plugins_raw = final_payload.get("plugins")
    if not isinstance(final_plugins_raw, list):
        raise SystemExit("error: final /api/agent/self-status missing plugins[]")
    final_plugin_by_name: dict[str, dict] = {}
    for entry in final_plugins_raw:
        if isinstance(entry, dict):
            name = entry.get("name") or entry.get("id")
            if isinstance(name, str):
                final_plugin_by_name[name] = entry
        elif isinstance(entry, str):
            final_plugin_by_name[entry] = {"name": entry, "status": "ready"}
    for required_plugin in required_plugins:
        entry = final_plugin_by_name.get(required_plugin)
        if entry is None:
            raise SystemExit(
                f"error: required plugin {required_plugin!r} missing from final self-status"
            )
        status = entry.get("status") if isinstance(entry, dict) else None
        if status != "ready":
            raise SystemExit(
                f"error: final plugin {required_plugin!r} status is {status!r}, expected 'ready'"
            )
    print(f"SELF_STATUS_FINAL_PLUGINS_READY={','.join(required_plugins)}")

    # Forensic sidecars.
    for shell_cmd, sidecar_name, marker in (
        (["logcat", "-d", "-b", "all"], "eliza-cuttlefish-agent-logcat.txt", "AGENT_LOGCAT"),
        (["dmesg"], "eliza-cuttlefish-agent-dmesg.txt", "AGENT_DMESG"),
        (["getprop"], "eliza-cuttlefish-agent-getprop.txt", "AGENT_GETPROP"),
    ):
        sidecar_path = out_dir / sidecar_name
        try:
            result = subprocess.run(
                adb_args(serial) + ["shell", *shell_cmd],
                text=True,
                capture_output=True,
                check=False,
            )
            sidecar_path.write_text(result.stdout or "")
        except OSError as exc:
            sidecar_path.write_text(f"forensic capture failed: {exc}\n")
        print(f"{marker}={sidecar_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
