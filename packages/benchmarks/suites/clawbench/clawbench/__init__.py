"""ClawBench - Evaluate AGENTS.md policies with OpenClaw."""

__version__ = "0.1.0"

from .sandbox import SandboxClient, SandboxError, setup_workspace

__all__ = ["SandboxClient", "SandboxError", "setup_workspace"]
