"""Diagnose why reward stays at 0.00 during training."""

import jax
import jax.numpy as jp
import mujoco

from eliza_robot.sim.mujoco.joystick import Joystick, default_config


def main():
    config = default_config()
    env = Joystick(config=config)

    print("=== Model Info ===")
    m = env.mj_model
    print(f"nq={m.nq}, nv={m.nv}, nu={m.nu}")
    print(f"timestep={m.opt.timestep}")
    print(f"Kp (gainprm[0]): {m.actuator_gainprm[0, 0]}")
    print(f"Kd (dof_damping[6]): {m.dof_damping[6]}")
    print(f"actuator_ctrlrange: {m.actuator_ctrlrange[:3]}")
    print()

    # Check stand keyframe
    init_q = m.keyframe("stand").qpos
    print(f"Stand keyframe qpos: {init_q}")
    print(f"  root pos: {init_q[:3]}")
    print(f"  root quat: {init_q[3:7]}")
    print(f"  joints: {init_q[7:]}")
    print()

    # CPU simulation test first
    print("=== CPU MuJoCo Test (100 steps with zero ctrl) ===")
    d = mujoco.MjData(m)
    d.qpos[:] = init_q
    mujoco.mj_forward(m, d)
    print(f"Step 0: torso_z={d.xpos[m.body('body_link').id, 2]:.4f}")

    for i in range(100):
        d.ctrl[:] = init_q[7:]  # hold default pose
        mujoco.mj_step(m, d)

    torso_id = m.body('body_link').id
    print(f"Step 100: torso_z={d.xpos[torso_id, 2]:.4f}")

    # Check gravity sensor
    grav_sensor_id = m.sensor("upvector").id
    grav_adr = m.sensor_adr[grav_sensor_id]
    grav_dim = m.sensor_dim[grav_sensor_id]
    gravity = d.sensordata[grav_adr:grav_adr+grav_dim]
    print(f"Step 100: gravity sensor = {gravity} (z={gravity[2]:.4f})")
    print(f"Step 100: terminate? gravity_z < 0.85 = {gravity[2] < 0.85}")
    print(f"Step 100: terminate? torso_z < 0.12 = {d.xpos[torso_id, 2] < 0.12}")
    print()

    # Now test via JAX/MJX env
    print("=== MJX Environment Test ===")
    rng = jax.random.PRNGKey(0)
    state = jax.jit(env.reset)(rng)

    print(f"After reset:")
    print(f"  reward={float(state.reward):.4f}")
    print(f"  done={float(state.done):.4f}")
    print(f"  torso_z={float(state.data.xpos[env._torso_body_id, 2]):.4f}")
    gravity = env.get_gravity(state.data)
    print(f"  gravity={gravity} (z={float(gravity[2]):.4f})")
    print(f"  qpos[:7]={state.data.qpos[:7]}")
    print()

    # Step with zero actions
    step_fn = jax.jit(env.step)
    action = jp.zeros(env.action_size)

    for i in range(20):
        state = step_fn(state, action)
        torso_z = float(state.data.xpos[env._torso_body_id, 2])
        grav = env.get_gravity(state.data)
        grav_z = float(grav[2])

        # Get individual reward components
        done_val = env.get_termination(state.data)

        print(f"Step {i+1:3d}: reward={float(state.reward):.4f}  "
              f"done={float(state.done):.1f}  "
              f"torso_z={torso_z:.4f}  "
              f"grav_z={grav_z:.4f}  "
              f"terminate={'YES' if grav_z < 0.85 or torso_z < 0.12 else 'no'}")

        if float(state.done) > 0.5:
            print(f"\n  >>> TERMINATED at step {i+1}")
            print(f"  >>> grav_z < 0.85? {grav_z < 0.85} (grav_z={grav_z:.4f})")
            print(f"  >>> torso_z < 0.12? {torso_z < 0.12} (torso_z={torso_z:.4f})")
            # Check joint limits
            joint_angles = state.data.qpos[7:]
            lowers = env._lowers
            uppers = env._uppers
            below = jp.any(joint_angles < lowers)
            above = jp.any(joint_angles > uppers)
            print(f"  >>> joint below limits? {bool(below)}")
            print(f"  >>> joint above limits? {bool(above)}")
            if bool(below) or bool(above):
                for j in range(len(joint_angles)):
                    if float(joint_angles[j]) < float(lowers[j]) or float(joint_angles[j]) > float(uppers[j]):
                        print(f"      joint {j}: val={float(joint_angles[j]):.4f}  range=[{float(lowers[j]):.4f}, {float(uppers[j]):.4f}]")
            break


if __name__ == "__main__":
    main()
