"""
Maestro Worker Package for GUI-Agent Architecture

This package provides specialized worker roles for different types of tasks:
- Operator: GUI interface operations with visual grounding
- Technician: System-level operations via terminal commands  
- Analyst: Data analysis and recommendations

The main MaestroWorker class provides a unified interface to all these roles.
"""

from .technician import Technician
from .analyst import Analyst
from .operator import Operator

__all__ = [
    "Technician",
    "Analyst",
    "Operator",
] 