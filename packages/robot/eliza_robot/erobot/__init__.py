"""erobot — a full-size injection-molded humanoid designed from scratch.

The parametric spec in :mod:`eliza_robot.erobot.spec` is the single source of
truth. Generators derive the MuJoCo model, the robot profile, the bill of
materials, and the mating/structural proofs from it.
"""

from eliza_robot.erobot.spec import RobotSpec, build_spec

__all__ = ["RobotSpec", "build_spec"]
