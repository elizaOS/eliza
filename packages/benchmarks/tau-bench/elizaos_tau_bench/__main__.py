"""
Entry point for running Tau-bench as a module.

Usage:
    python -m elizaos_tau_bench --all
    python -m elizaos_tau_bench --domain retail --trials 8
"""

from elizaos_tau_bench.cli import main

if __name__ == "__main__":
    main()
