#!/usr/bin/env python3
"""
Babylon Training & Benchmark - RunPod Deployment

Simple script to spin up training and benchmark pods on RunPod.

Usage:
    # Training (using env file)
    python setup.py train --gpu h100 --image user/babylon-training:latest --env-file ../.env
    
    # Benchmark with HuggingFace model
    python setup.py benchmark --gpu h100 --hf-model elizaos/ishtar-v0.1
    
    # Benchmark with local model (must be accessible via volume or pre-baked in image)
    python setup.py benchmark --gpu h100 --model /models/final_model
    
    # List pods
    python setup.py list
    
    # Stop/delete pod
    python setup.py stop <pod-id>

Requires: RUNPOD_API_KEY environment variable or in env file
"""

import argparse
import os
import sys
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("pip install requests")

API = "https://rest.runpod.io/v1"

# GPU short names -> RunPod IDs
GPUS = {
    "4090": "NVIDIA GeForce RTX 4090",
    "a100": "NVIDIA A100 80GB PCIe", 
    "l40s": "NVIDIA L40S",
    "h100": "NVIDIA H100 80GB HBM3",
    "h200": "NVIDIA H200",
}

# Default single-GPU profile by GPU class
SINGLE_GPU_PROFILES = {
    "4090": "24gb",
    "a100": "a100",
    "l40s": "l40",
    "h100": "h100",
    "h200": "h200",
}

# Recommended multi-GPU profiles for supported counts
PROFILE_MATRIX = {
    ("a100", 2): "a100-2gpu",
    ("a100", 4): "a100-4gpu",
    ("h100", 2): "h100-2gpu",
    ("h100", 4): "h100-4gpu",
    ("h200", 2): "h200-2gpu",
    ("l40s", 2): "l40-2gpu",
    ("l40s", 4): "l40-4gpu",
    ("l40s", 8): "l40-8gpu",
}


def resolve_profile(gpu: str, gpu_count: int, explicit_profile: str | None = None) -> str:
    """Resolve the training profile for a GPU/count combination."""
    if explicit_profile:
        return explicit_profile
    if (gpu, gpu_count) in PROFILE_MATRIX:
        return PROFILE_MATRIX[(gpu, gpu_count)]
    if gpu_count == 1:
        return SINGLE_GPU_PROFILES.get(gpu, "24gb")

    supported = sorted(count for name, count in PROFILE_MATRIX if name == gpu)
    if supported:
        supported_str = ", ".join(str(count) for count in supported)
        sys.exit(
            f"No auto profile for {gpu_count}x {gpu}. "
            f"Supported counts for {gpu}: {supported_str}. "
            "Pass --profile explicitly if you know what you want."
        )
    sys.exit(
        f"No auto profile for {gpu_count}x {gpu}. "
        "Pass --profile explicitly for this configuration."
    )


def default_storage_sizes(gpu: str, gpu_count: int) -> tuple[int, int]:
    """Return reasonable default persistent volume and container disk sizes."""
    base = {
        "4090": (100, 50),
        "l40s": (125, 75),
        "a100": (150, 100),
        "h100": (200, 150),
        "h200": (250, 150),
    }.get(gpu, (100, 50))

    volume_gb, container_disk_gb = base
    if gpu_count >= 4:
        volume_gb = max(volume_gb, 400)
        container_disk_gb = max(container_disk_gb, 200)
    elif gpu_count == 2:
        volume_gb = max(volume_gb, 250 if gpu in {"h100", "h200"} else 200)
        container_disk_gb = max(container_disk_gb, 150 if gpu in {"a100", "h100", "h200"} else 100)
    return volume_gb, container_disk_gb


def apply_common_env_overrides(env: dict, args) -> None:
    """Apply shared CLI/env-file overrides used by training and shell pods."""
    if args.db:
        env["DATABASE_URL"] = args.db
    if args.wandb:
        env["WANDB_API_KEY"] = args.wandb
        env["WANDB_MODE"] = "online"
    if args.hf_token:
        env["HF_TOKEN"] = args.hf_token

    hf_token = env.get("HF_TOKEN") or os.environ.get("HF_TOKEN")
    if hf_token:
        env["HF_TOKEN"] = hf_token

    hf_dataset = getattr(args, "hf_dataset", None)
    if hf_dataset:
        env["HF_TRAJECTORY_DATASET"] = hf_dataset
        env["TRAJECTORY_SOURCE"] = "huggingface"


def load_runtime_env(args) -> dict:
    """Load environment variables from env file and CLI overrides."""
    env = {}
    if args.env_file:
        env = load_env_file(args.env_file)
        print(f"Loaded {len(env)} environment variables from {args.env_file}")
        if "RUNPOD_API_KEY" in env and not os.environ.get("RUNPOD_API_KEY"):
            os.environ["RUNPOD_API_KEY"] = env["RUNPOD_API_KEY"]

    apply_common_env_overrides(env, args)
    return env


def load_env_file(path: str) -> dict:
    """Load environment variables from a file."""
    env = {}
    path = Path(path)
    if not path.exists():
        sys.exit(f"Env file not found: {path}")
    
    with open(path) as f:
        for line in f:
            line = line.strip()
            # Skip comments and empty lines
            if not line or line.startswith("#"):
                continue
            # Parse KEY=VALUE
            if "=" in line:
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip()
                # Remove quotes if present
                if value.startswith('"') and value.endswith('"'):
                    value = value[1:-1]
                elif value.startswith("'") and value.endswith("'"):
                    value = value[1:-1]
                if value:  # Only set non-empty values
                    env[key] = value
    return env


def load_api_key():
    """Load RUNPOD_API_KEY from environment or default .env file."""
    key = os.environ.get("RUNPOD_API_KEY")
    if key:
        return key
    
    # Try loading from default .env locations
    script_dir = Path(__file__).parent
    env_locations = [
        script_dir / ".env",
        script_dir.parent / ".env",
        script_dir.parent / "deploy" / ".env",
    ]
    
    for env_path in env_locations:
        if env_path.exists():
            env = load_env_file(str(env_path))
            if "RUNPOD_API_KEY" in env:
                return env["RUNPOD_API_KEY"]
    
    return None


def api(method, endpoint, data=None):
    """Make API request."""
    key = load_api_key()
    if not key:
        sys.exit("Set RUNPOD_API_KEY (https://console.runpod.io/user/settings) or use --env-file")
    
    r = requests.request(
        method, f"{API}{endpoint}",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json=data
    )
    if r.status_code >= 400:
        sys.exit(f"API error {r.status_code}: {r.text}")
    return r.json() if r.text else None


def cmd_train(args):
    """Create a training pod."""
    gpu_id = GPUS.get(args.gpu)
    if not gpu_id:
        sys.exit(f"Unknown GPU. Available: {', '.join(GPUS.keys())}")

    env = load_runtime_env(args)

    profile = resolve_profile(
        args.gpu,
        args.gpus,
        args.profile or env.get("TRAINING_PROFILE"),
    )
    steps = args.steps or int(env.get("TRAINING_STEPS", 1000))
    min_agents = args.min_agents_per_window or int(env.get("MIN_AGENTS_PER_WINDOW", 1))
    volume_gb, container_disk_gb = default_storage_sizes(args.gpu, args.gpus)
    volume_gb = args.volume_gb or volume_gb
    container_disk_gb = args.container_disk_gb or container_disk_gb
    
    # Ensure data source - CLI --hf-dataset, env HF_TRAJECTORY_DATASET, or DATABASE_URL
    hf_dataset = env.get("HF_TRAJECTORY_DATASET")
    trajectory_source = env.get("TRAJECTORY_SOURCE", "db").lower()
    
    if trajectory_source == "huggingface" and not hf_dataset:
        sys.exit("TRAJECTORY_SOURCE=huggingface but no HF dataset. Use --hf-dataset or set HF_TRAJECTORY_DATASET in env file.")
    elif trajectory_source != "huggingface" and not hf_dataset and "DATABASE_URL" not in env:
        sys.exit("Data source required. Use --hf-dataset, set HF_TRAJECTORY_DATASET, or set DATABASE_URL in env file.")
    
    # Build docker command
    docker_cmd = [
        "python3", "python/scripts/run_training.py",
        "--profile", profile,
        "--steps", str(steps),
        "--min-agents-per-window", str(min_agents)
    ]
    
    # Add HuggingFace dataset if specified
    if hf_dataset:
        docker_cmd.extend(["--hf-dataset", hf_dataset])
    
    pod = api("POST", "/pods", {
        "name": args.name or f"babylon-{args.gpu}",
        "imageName": args.image,
        "gpuTypeIds": [gpu_id],
        "gpuCount": args.gpus,
        "volumeInGb": volume_gb,
        "containerDiskInGb": container_disk_gb,
        "env": env,
        "dockerStartCmd": docker_cmd,
        "ports": ["8888/http", "22/tcp"],
        "cloudType": "COMMUNITY" if args.community else "SECURE",
        "interruptible": args.spot,
        "supportPublicIp": True,
    })
    
    print(f"\n✓ Created pod: {pod['id']}")
    print(f"  Name: {args.name or f'babylon-{args.gpu}'}")
    print(f"  GPU: {gpu_id}")
    print(f"  GPU count: {args.gpus}")
    print(f"  Profile: {profile}")
    print(f"  Steps: {steps}")
    print(f"  Min agents/window: {min_agents}")
    print(f"  Volume: {volume_gb} GB")
    print(f"  Container disk: {container_disk_gb} GB")
    print(f"  Spot: {args.spot}")
    print("\n  View at: https://console.runpod.io/pods")


def cmd_shell(args):
    """Create a shell pod that stays up for manual training and benchmarking."""
    gpu_id = GPUS.get(args.gpu)
    if not gpu_id:
        sys.exit(f"Unknown GPU. Available: {', '.join(GPUS.keys())}")

    env = load_runtime_env(args)
    profile = resolve_profile(
        args.gpu,
        args.gpus,
        args.profile or env.get("TRAINING_PROFILE"),
    )
    volume_gb, container_disk_gb = default_storage_sizes(args.gpu, args.gpus)
    volume_gb = args.volume_gb or volume_gb
    container_disk_gb = args.container_disk_gb or container_disk_gb

    pod = api("POST", "/pods", {
        "name": args.name or f"babylon-shell-{args.gpu}",
        "imageName": args.image,
        "gpuTypeIds": [gpu_id],
        "gpuCount": args.gpus,
        "volumeInGb": volume_gb,
        "containerDiskInGb": container_disk_gb,
        "env": env,
        "dockerStartCmd": ["sleep", "infinity"],
        "ports": ["22/tcp"],
        "cloudType": "COMMUNITY" if args.community else "SECURE",
        "interruptible": args.spot,
        "supportPublicIp": True,
    })

    print(f"\n✓ Created shell pod: {pod['id']}")
    print(f"  Name: {args.name or f'babylon-shell-{args.gpu}'}")
    print(f"  GPU: {gpu_id}")
    print(f"  GPU count: {args.gpus}")
    print(f"  Suggested profile: {profile}")
    print(f"  Volume: {volume_gb} GB")
    print(f"  Container disk: {container_disk_gb} GB")
    print(f"  Spot: {args.spot}")
    print("\n  Use this when you want to SSH in, run the canonical pipeline manually,")
    print("  collect artifacts, and shut the pod down yourself.")
    print("\n  View at: https://console.runpod.io/pods")


def cmd_list(args):
    """List running pods."""
    # Load env file if provided
    if hasattr(args, 'env_file') and args.env_file:
        env = load_env_file(args.env_file)
        if "RUNPOD_API_KEY" in env and not os.environ.get("RUNPOD_API_KEY"):
            os.environ["RUNPOD_API_KEY"] = env["RUNPOD_API_KEY"]
    
    pods = api("GET", "/pods?includeMachine=true")
    if not pods:
        print("No pods.")
        return
    
    print(f"\n{'ID':<16} {'Name':<20} {'Status':<10} {'GPU':<25} {'$/hr':<8}")
    print("-" * 80)
    for p in pods:
        gpu = p.get("machine", {}).get("gpuDisplayName", "?")[:24] if p.get("machine") else "?"
        cost = f"${p.get('costPerHr', 0):.2f}" if p.get("costPerHr") else "?"
        print(f"{p['id']:<16} {(p.get('name') or '?')[:19]:<20} {p['desiredStatus']:<10} {gpu:<25} {cost:<8}")
    print()


def cmd_stop(args):
    """Stop and delete a pod."""
    api("DELETE", f"/pods/{args.pod_id}")
    print(f"✓ Deleted pod {args.pod_id}")


def cmd_logs(args):
    """Get pod logs (requires SSH or web console)."""
    print(f"View logs at: https://console.runpod.io/pods?id={args.pod_id}")


def cmd_benchmark(args):
    """Create a benchmark pod."""
    gpu_id = GPUS.get(args.gpu)
    if not gpu_id:
        sys.exit(f"Unknown GPU. Available: {', '.join(GPUS.keys())}")
    
    # Load env file if provided
    env = {}
    if args.env_file:
        env = load_env_file(args.env_file)
        print(f"Loaded {len(env)} environment variables from {args.env_file}")
        
        # Set RUNPOD_API_KEY from env file if not already set
        if "RUNPOD_API_KEY" in env and not os.environ.get("RUNPOD_API_KEY"):
            os.environ["RUNPOD_API_KEY"] = env["RUNPOD_API_KEY"]
    
    # Benchmark-specific env vars
    if args.hf_model:
        env["HF_MODEL"] = args.hf_model
    if args.model:
        env["MODEL_PATH"] = args.model
    if args.base_model:
        env["BASE_MODEL"] = args.base_model
    
    # Propagate HF_TOKEN from CLI arg, env file, or host environment
    hf_token = args.hf_token or env.get("HF_TOKEN") or os.environ.get("HF_TOKEN")
    if hf_token:
        env["HF_TOKEN"] = hf_token
    
    if args.quick:
        env["BENCHMARK_QUICK"] = "true"
    if args.scenario:
        env["BENCHMARK_SCENARIO"] = args.scenario
    
    # Validate model source
    if not args.hf_model and not args.model:
        sys.exit("Either --hf-model or --model is required for benchmarking.")
    
    # Determine image
    image = args.image or f"{os.environ.get('DOCKER_REGISTRY', 'revlentless')}/babylon-benchmark:latest"
    
    # Build docker command (entrypoint handles the rest via env vars)
    docker_cmd = []  # Use image's default entrypoint
    
    pod = api("POST", "/pods", {
        "name": args.name or f"babylon-bench-{args.gpu}",
        "imageName": image,
        "gpuTypeIds": [gpu_id],
        "gpuCount": 1,  # Benchmark typically needs 1 GPU
        "volumeInGb": 50,
        "containerDiskInGb": 50,
        "env": env,
        "dockerStartCmd": docker_cmd if docker_cmd else None,
        "ports": ["9001/http"],  # vLLM port
        "cloudType": "COMMUNITY" if args.community else "SECURE",
        "interruptible": args.spot,
        "supportPublicIp": True,
    })
    
    print(f"\n✓ Created benchmark pod: {pod['id']}")
    print(f"  Name: {args.name or f'babylon-bench-{args.gpu}'}")
    print(f"  GPU: {gpu_id}")
    if args.hf_model:
        print(f"  HF Model: {args.hf_model}")
    if args.model:
        print(f"  Model Path: {args.model}")
    if args.base_model:
        print(f"  Base Model: {args.base_model}")
    print(f"  Quick mode: {args.quick}")
    if args.scenario:
        print(f"  Scenario: {args.scenario}")
    print(f"  Spot: {args.spot}")
    print("\n  View at: https://console.runpod.io/pods")


def main():
    p = argparse.ArgumentParser(
        description="Babylon RunPod Training & Benchmarking",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Training Examples:
  # Using HuggingFace dataset (recommended for RunPod)
  python setup.py train --gpu h100 --image user/babylon-training:latest --env-file ../.env --hf-dataset elizaos/enkidu-trajectories-raw
  
  # Using database URL (requires network access to DB)
  python setup.py train --gpu h100 --image user/babylon-training:latest --db "postgresql://..."
  
  # Spot instance (cheaper)
  python setup.py train --gpu 4090 --image user/babylon-training:latest --env-file .env --hf-dataset org/dataset --spot

Benchmark Examples:
  # Benchmark HuggingFace model
  python setup.py benchmark --gpu h100 --hf-model elizaos/ishtar-v0.1 --base-model Qwen/Qwen3.5-9B --quick

Shell Pod Examples:
  # Provision a 2x H100 box for a manual canonical pipeline run
  python setup.py shell --gpu h100 --gpus 2 --image user/babylon-training:latest --env-file ../.env
  
  # Provision a single H200 shell pod for co-hosted 7B-9B training + inference
  python setup.py shell --gpu h200 --image user/babylon-training:latest --env-file ../.env
  
  # Specific scenario
  python setup.py benchmark --gpu 4090 --hf-model elizaos/ishtar-v0.1 --base-model Qwen/Qwen2.5-0.5B-Instruct --scenario bear-market
  
  # Spot instance for cost savings
  python setup.py benchmark --gpu 4090 --hf-model elizaos/ishtar-v0.1 --base-model Qwen/Qwen2.5-0.5B-Instruct --spot --community
"""
    )
    sub = p.add_subparsers(dest="cmd")
    
    # train
    t = sub.add_parser("train", help="Start a training pod")
    t.add_argument("--gpu", required=True, choices=GPUS.keys(), help="GPU type")
    t.add_argument("--image", required=True, help="Docker image")
    t.add_argument("--env-file", help="Path to .env file (recommended)")
    t.add_argument("--name", help="Pod name (default: babylon-<gpu>)")
    t.add_argument("--gpus", type=int, default=1, help="GPU count")
    t.add_argument("--steps", type=int, help="Training steps (default: from env or 1000)")
    t.add_argument("--profile", help="Training profile (default: auto from GPU)")
    t.add_argument("--volume-gb", type=int, help="Persistent volume size in GB (default: auto from GPU)")
    t.add_argument("--container-disk-gb", type=int, help="Container disk size in GB (default: auto from GPU)")
    t.add_argument("--db", help="DATABASE_URL (overrides env file)")
    t.add_argument("--wandb", help="WANDB_API_KEY (overrides env file)")
    t.add_argument("--hf-token", help="HF_TOKEN (overrides env file)")
    t.add_argument("--hf-dataset", help="HuggingFace dataset ID for training data (instead of DATABASE_URL)")
    t.add_argument("--min-agents-per-window", type=int, help="Min trajectories per window (default: 1)")
    t.add_argument("--spot", action="store_true", help="Use spot instance (cheaper, may interrupt)")
    t.add_argument("--community", action="store_true", help="Use community cloud (cheaper)")

    sh = sub.add_parser("shell", help="Start a shell pod for manual training and benchmarking")
    sh.add_argument("--gpu", required=True, choices=GPUS.keys(), help="GPU type")
    sh.add_argument("--image", required=True, help="Docker image")
    sh.add_argument("--env-file", help="Path to .env file (recommended)")
    sh.add_argument("--name", help="Pod name (default: babylon-shell-<gpu>)")
    sh.add_argument("--gpus", type=int, default=1, help="GPU count")
    sh.add_argument("--profile", help="Suggested training profile (default: auto from GPU)")
    sh.add_argument("--volume-gb", type=int, help="Persistent volume size in GB (default: auto from GPU)")
    sh.add_argument("--container-disk-gb", type=int, help="Container disk size in GB (default: auto from GPU)")
    sh.add_argument("--db", help="DATABASE_URL (overrides env file)")
    sh.add_argument("--wandb", help="WANDB_API_KEY (overrides env file)")
    sh.add_argument("--hf-token", help="HF_TOKEN (overrides env file)")
    sh.add_argument("--hf-dataset", help="Optional HuggingFace dataset ID to preload into env")
    sh.add_argument("--spot", action="store_true", help="Use spot instance (cheaper, may interrupt)")
    sh.add_argument("--community", action="store_true", help="Use community cloud (cheaper)")
    
    # list
    lst = sub.add_parser("list", help="List pods")
    lst.add_argument("--env-file", help="Path to .env file (for RUNPOD_API_KEY)")
    
    # stop
    s = sub.add_parser("stop", help="Delete a pod")
    s.add_argument("pod_id", help="Pod ID")
    
    # logs
    lg = sub.add_parser("logs", help="View pod logs")
    lg.add_argument("pod_id", help="Pod ID")
    
    # benchmark
    b = sub.add_parser("benchmark", help="Start a benchmark pod")
    b.add_argument("--gpu", required=True, choices=GPUS.keys(), help="GPU type")
    b.add_argument("--image", help="Docker image (default: revlentless/babylon-benchmark:latest)")
    b.add_argument("--hf-model", help="HuggingFace model ID to benchmark")
    b.add_argument("--base-model", help="Base model for vLLM inside the benchmark container")
    b.add_argument("--model", help="Path to model inside container")
    b.add_argument("--env-file", help="Path to .env file")
    b.add_argument("--name", help="Pod name (default: babylon-bench-<gpu>)")
    b.add_argument("--hf-token", help="HF_TOKEN for private models")
    b.add_argument("--quick", action="store_true", help="Quick mode (7-day scenarios)")
    b.add_argument("--scenario", help="Specific scenario to run")
    b.add_argument("--spot", action="store_true", help="Use spot instance")
    b.add_argument("--community", action="store_true", help="Use community cloud")
    
    args = p.parse_args()
    
    if args.cmd == "train":
        cmd_train(args)
    elif args.cmd == "shell":
        cmd_shell(args)
    elif args.cmd == "benchmark":
        cmd_benchmark(args)
    elif args.cmd == "list":
        cmd_list(args)
    elif args.cmd == "stop":
        cmd_stop(args)
    elif args.cmd == "logs":
        cmd_logs(args)
    else:
        p.print_help()


if __name__ == "__main__":
    main()
