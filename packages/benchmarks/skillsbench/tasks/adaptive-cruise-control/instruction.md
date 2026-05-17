You need to implement an Adaptive Cruise Control (ACC) simulation that maintains the set speed (30m/s) when no vehicles are detected ahead, and automatically adjusts speed to maintain a safe following distance when a vehicle is detected ahead. The targets are: speed rise time <10s, speed overshoot <5%, speed steady-state error <0.5 m/s, distance steady-state error <2m, minimum distance >5m, control duration 150s. Also consider the constraints: initial speed ~0 m/s, acceleration limits [-8.0, 3.0] m/s^2, time headway 1.5s, minimum gap 10.0m, emergency TTC threshold 3.0s, timestep 0.1s. Data is available in vehicle_params.yaml(Vehicle specs and ACC settings)  and sensor_data.csv (1501 rows (t=0-150s) with columns: time, ego_speed, lead_speed, distance, collected from real-world driving).


First, create pid_controller.py to implement the PID controller. Then, create acc_system.py to implement the ACC system and simulation.py to run the vehicle simulation. Next, tune the PID parameters for speed and distance control, saving results in tuning_results.yaml. Finally, run 150s simulations, producing simulation_results.csv and acc_report.md.


Examples output format:

pid_controller.py:
Class: PIDController
Constructor: __init__(self, kp, ki, kd)
Methods: reset(), compute(error, dt) returns float

acc_system.py:
Class: AdaptiveCruiseControl
Constructor: __init__(self, config) where config is nested dict from vehicle_params.yaml (e.g., config['acc_settings']['set_speed'])
Method: compute(ego_speed, lead_speed, distance, dt) returns tuple (acceleration_cmd, mode, distance_error)
Mode selection: 'cruise' when lead_speed is None, 'emergency' when TTC < threshold, 'follow' when lead vehicle present

simulation.py:
Read PID gains from tuning_results.yaml file at runtime.
Do not embed auto-tuning logic because gains should be loaded from the yaml file.
Uses sensor_data.csv for lead vehicle data (lead_speed, distance).

tuning_results.yaml, kp in (0,10), ki in [0,5), kd in [0,5):
pid_speed:
  kp: <value>w
  ki: <value>
  kd: <value>
pid_distance:
  kp: <value>
  ki: <value>
  kd: <value>

simulation_results.csv:
(exactly 1501 rows, exact same column order)
time,ego_speed,acceleration_cmd,mode,distance_error,distance,ttc
0.0,0.0,3.0,cruise,,,
0.1,0.3,3.0,cruise,,,
0.2,0.6,3.0,cruise,,,
0.3,0.9,3.0,cruise,,,
0.4,1.2,3.0,cruise,,,
0.5,1.5,3.0,cruise,,,
0.6,1.8,3.0,cruise,,,

acc_report.md:
Include sections covering:
System design (ACC architecture, modes, safety features)
PID tuning methodology and final gains
Simulation results and performance metrics
