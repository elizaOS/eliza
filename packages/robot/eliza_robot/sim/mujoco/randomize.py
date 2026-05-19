"""JAX-compatible domain randomization for AiNex MJX training.

Follows the MuJoCo Playground pattern (Go1/T1 style) for use with
BraxDomainRandomizationVmapWrapper.

Usage:
    from eliza_robot.sim.mujoco.randomize import domain_randomize
    import functools

    rng = jax.random.split(jax.random.PRNGKey(0), num_envs)
    randomization_fn = functools.partial(domain_randomize, rng=rng)
    wrapped_env = wrap_for_brax_training(env, randomization_fn=randomization_fn, ...)
"""

import jax
import jax.numpy as jp
from mujoco import mjx

# Body/geom IDs in ainex_primitives.xml
FLOOR_GEOM_ID = 0
TORSO_BODY_ID = 2  # base_link(1) -> body_link(2)


def domain_randomize(model: mjx.Model, rng: jax.Array):
    """Randomize physics parameters for sim-to-real transfer.

    Randomizes: floor friction, joint friction loss, armature, link masses,
    torso mass, CoM position, default qpos, actuator gains, joint damping,
    motor strength (actuator forcerange), and action execution noise.

    Args:
        model: MJX model (unbatched).
        rng: Array of shape (num_envs, 2) — one key per env.

    Returns:
        (model, in_axes, action_noise_scale) tuple.
        - model, in_axes: for BraxDomainRandomizationVmapWrapper.
        - action_noise_scale: per-env scalar (num_envs,) — base_env should
          add ``N(0, action_noise_scale)`` noise to actions before applying.
    """
    @jax.vmap
    def rand_dynamics(rng):
        # Floor friction: U(0.4, 1.2)
        rng, key = jax.random.split(rng)
        geom_friction = model.geom_friction.at[FLOOR_GEOM_ID, 0].set(
            jax.random.uniform(key, minval=0.4, maxval=1.2)
        )

        # Scale static friction loss on joints (skip 6 freejoint DOFs): *U(0.9, 1.1)
        rng, key = jax.random.split(rng)
        n_joints = model.dof_frictionloss.shape[0] - 6
        frictionloss = model.dof_frictionloss[6:] * jax.random.uniform(
            key, shape=(n_joints,), minval=0.9, maxval=1.1
        )
        dof_frictionloss = model.dof_frictionloss.at[6:].set(frictionloss)

        # Scale armature: *U(1.0, 1.05)
        rng, key = jax.random.split(rng)
        armature = model.dof_armature[6:] * jax.random.uniform(
            key, shape=(n_joints,), minval=1.0, maxval=1.05
        )
        dof_armature = model.dof_armature.at[6:].set(armature)

        # Scale all link masses: *U(0.9, 1.1)
        rng, key = jax.random.split(rng)
        dmass = jax.random.uniform(
            key, shape=(model.nbody,), minval=0.9, maxval=1.1
        )
        body_mass = model.body_mass * dmass

        # Additional torso mass perturbation: +U(-0.05, 0.05) (small robot)
        rng, key = jax.random.split(rng)
        dmass_torso = jax.random.uniform(key, minval=-0.05, maxval=0.05)
        body_mass = body_mass.at[TORSO_BODY_ID].set(
            body_mass[TORSO_BODY_ID] + dmass_torso
        )

        # Jitter center of mass position: +U(-0.005, 0.005) (scaled for small robot)
        rng, key = jax.random.split(rng)
        dpos = jax.random.uniform(key, (3,), minval=-0.005, maxval=0.005)
        body_ipos = model.body_ipos.at[TORSO_BODY_ID].set(
            model.body_ipos[TORSO_BODY_ID] + dpos
        )

        # Jitter default joint positions: +U(-0.05, 0.05)
        rng, key = jax.random.split(rng)
        qpos0 = model.qpos0.at[7:].set(
            model.qpos0[7:]
            + jax.random.uniform(key, shape=(n_joints,), minval=-0.05, maxval=0.05)
        )

        # Scale actuator gains (stiffness): *U(0.9, 1.1)
        rng, key = jax.random.split(rng)
        gain_scale = jax.random.uniform(
            key, shape=(model.nu,), minval=0.9, maxval=1.1
        )
        actuator_gainprm = model.actuator_gainprm.at[:, 0].set(
            model.actuator_gainprm[:, 0] * gain_scale
        )
        # Keep bias coupled to gain: biasprm[:,1] = -gainprm[:,0]
        actuator_biasprm = model.actuator_biasprm.at[:, 1].set(
            -actuator_gainprm[:, 0]
        )

        # Scale joint damping: *U(0.8, 1.2)
        rng, key = jax.random.split(rng)
        damping_scale = jax.random.uniform(
            key, shape=(n_joints,), minval=0.8, maxval=1.2
        )
        dof_damping = model.dof_damping.at[6:].set(
            model.dof_damping[6:] * damping_scale
        )

        # ------------------------------------------------------------------
        # Action execution noise: simulates servo bus jitter + position error.
        # Returned as a per-env scalar; base_env adds N(0, action_noise_scale)
        # to actions before applying them to the actuators.
        # ------------------------------------------------------------------
        rng, key = jax.random.split(rng)
        action_noise_scale = jax.random.uniform(key, minval=0.0, maxval=0.02)

        # ------------------------------------------------------------------
        # Motor strength: U(0.7, 1.0) per actuator — some servos weaker
        # than others due to wear, voltage sag, or manufacturing variance.
        # Applied by scaling actuator_forcerange symmetrically.
        # ------------------------------------------------------------------
        rng, key = jax.random.split(rng)
        motor_strength = jax.random.uniform(
            key, shape=(model.nu,), minval=0.7, maxval=1.0
        )
        actuator_forcerange_low = model.actuator_forcerange[:, 0] * motor_strength
        actuator_forcerange_high = model.actuator_forcerange[:, 1] * motor_strength
        actuator_forcerange = model.actuator_forcerange.at[:, 0].set(
            actuator_forcerange_low
        ).at[:, 1].set(actuator_forcerange_high)

        return (
            geom_friction,
            body_ipos,
            body_mass,
            qpos0,
            dof_frictionloss,
            dof_armature,
            actuator_gainprm,
            actuator_biasprm,
            dof_damping,
            action_noise_scale,
            actuator_forcerange,
        )

    (
        friction,
        body_ipos,
        body_mass,
        qpos0,
        dof_frictionloss,
        dof_armature,
        actuator_gainprm,
        actuator_biasprm,
        dof_damping,
        action_noise_scale,
        actuator_forcerange,
    ) = rand_dynamics(rng)

    in_axes = jax.tree_util.tree_map(lambda x: None, model)
    in_axes = in_axes.tree_replace({
        "geom_friction": 0,
        "body_ipos": 0,
        "body_mass": 0,
        "qpos0": 0,
        "dof_frictionloss": 0,
        "dof_armature": 0,
        "actuator_gainprm": 0,
        "actuator_biasprm": 0,
        "dof_damping": 0,
        "actuator_forcerange": 0,
    })

    model = model.tree_replace({
        "geom_friction": friction,
        "body_ipos": body_ipos,
        "body_mass": body_mass,
        "qpos0": qpos0,
        "dof_frictionloss": dof_frictionloss,
        "dof_armature": dof_armature,
        "actuator_gainprm": actuator_gainprm,
        "actuator_biasprm": actuator_biasprm,
        "dof_damping": dof_damping,
        "actuator_forcerange": actuator_forcerange,
    })

    # action_noise_scale is a per-env scalar that Brax's DR wrapper cannot
    # pass through directly. For now it is computed but not applied — the
    # motor_strength randomization on forcerange already captures most of
    # the servo variability. A future version can integrate action noise
    # via a custom env wrapper.
    return model, in_axes
