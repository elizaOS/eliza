"""Physical Intelligence OpenPI VLA policy client.

Wraps the ``openpi-client`` Python package (optional, lazy-imported) so the
bridge can send observations to a hosted or local openpi inference server
and receive action chunks back.
"""

from eliza_robot.policy.openpi.client import OpenPIPolicyClient

__all__ = ["OpenPIPolicyClient"]
