# erobot — Bill of Materials

Generated from the parametric spec by `eliza_robot.erobot.bom`. Priced 2026-05-30 (USD).
Prices are planning numbers — confirmed items cite a live vendor page; estimated items
need an RFQ. Re-run `python -m eliza_robot.erobot.build` to regenerate.

## Totals

- Robot: 25-DoF humanoid, 1.665 m standing.
- **BOM mass: 27.648 kg** (sim mass model: 26.149 kg; the delta is discrete bearings/fasteners/wear pads not modeled as sim shells).
- **Unit cost @ qty 1: $16,184.79**
- **Unit cost @ qty 1000: $10,010.83/unit** (incl. amortized tooling).
- Tooling capex: $91,000.00 across 13 molds.

## By category

| Category | Qty | Mass (kg) | Cost @ qty 1 | Cost @ qty 1000 |
|---|---:|---:|---:|---:|
| actuator | 25 | 13.56 | $13,300.46 | $8,625.00 |
| molded_shell | 22 | 8.75 | $970.83 | $299.83 |
| bearing | 6 | 1.62 | $660.00 | $288.00 |
| power | 2 | 3.10 | $540.00 | $185.00 |
| sensor | 2 | 0.08 | $338.50 | $230.00 |
| compute | 1 | 0.18 | $249.00 | $230.00 |
| fastener | 7 | 0.26 | $90.00 | $48.00 |
| wear | 2 | 0.10 | $36.00 | $14.00 |

## Off-the-shelf parts

| Part | Vendor / Model | Spec | Qty | Unit mass (kg) | Unit $ (qty 1) | Unit $ (qty 1k) | Price | Source |
|---|---|---|---:|---:|---:|---:|:--:|---|
| High-torque leg actuator | CubeMars AK80-64 (KV80) | 120 N·m peak / 48 N·m rated, 48 V, CAN | 6 | 0.850 | $889.90 | $560.00 | confirmed | [link](https://store.cubemars.com/products/ak80-64) |
| Mid-torque joint actuator | CubeMars AK70-10 (KV100) | 24.8 N·m peak / 8.3 N·m rated, 48 V, CAN | 15 | 0.520 | $398.90 | $255.00 | confirmed | [link](https://store.cubemars.com/products/ak70-10) |
| Low-torque smart servo | Robotis Dynamixel XM540-W270-R | 10.6 N·m stall, 12 V, TTL/RS-485 | 4 | 0.165 | $494.39 | $360.00 | confirmed | [link](https://robotis.us/dynamixel-xm540-w270-r/) |
| Onboard compute | NVIDIA Jetson Orin Nano Super Dev Kit | 8 GB, 67 TOPS | 1 | 0.180 | $249.00 | $230.00 | confirmed | [link](https://www.nvidia.com/en-us/autonomous-machines/embedded-systems/jetson-orin/nano-super-developer-kit/) |
| IMU | Bosch / SparkFun BMI088 breakout | 6-axis, SPI/I2C | 1 | 0.010 | $18.50 | $10.00 | confirmed | [link](https://www.digikey.com/en/products/detail/bosch-sensortec/BMI088/8634936) |
| Head depth + RGB camera | Intel RealSense D435i | stereo depth + RGB + IMU, ~10 m | 1 | 0.072 | $320.00 | $220.00 | est. | [link](https://store.intelrealsense.com/buy-intel-realsense-depth-camera-d435i.html) |
| Battery pack | Custom (Aegis/DNK class) 13S Li-ion NMC ~400 Wh | ~46 V, ~400 Wh | 1 | 2.200 | $420.00 | $130.00 | est. | [link](https://www.bioennopower.com/products/48v-10ah-lfp-battery-black-a-pvc-pack) |
| Power distribution board + DC-DC + wiring | Custom / Pololu PDB + 48->5/12/19 V buck + harness | split rails, e-stop | 1 | 0.900 | $120.00 | $55.00 | est. | [link](https://www.pololu.com/category/130/step-down-voltage-regulators) |
| Crossed-roller joint bearing | THK RB5013 (50x80x13 mm) | crossed-roller slewing | 6 | 0.270 | $110.00 | $48.00 | est. | [link](https://us.amazon.com/Original-Roller-Bearings-RB5013UUCC0-RB5013UUC0/dp/B0DSZFCC7Y) |
| Brass heat-set inserts (M3x5.7) | CNC Kitchen M3 x 5.7 (100 pc) | for plastic bosses | 3 | 0.020 | $14.00 | $8.00 | est. | [link](https://cnckitchen.store/products/heat-set-insert-m3-x-5-7-100-pieces) |
| Socket-head screws M3/M4 (assorted) | McMaster-Carr A2 stainless SHCS kit | M3/M4 x various | 4 | 0.050 | $12.00 | $6.00 | est. | [link](https://www.mcmaster.com/products/inserts/thread-size~m3/) |
| Molded TPU sole pads | Custom TPU 90A sole (pair) | high-friction wear pad | 2 | 0.050 | $18.00 | $7.00 | est. | [link](https://www.polymersx.com/product/tpu-price/) |

## Custom injection-molded shells

Each unique shell is a 2-piece clamshell bolted around its actuator with brass heat-set inserts (left/right mirrors share one mold). Qty-1 is the FDM/SLA prototype regime; qty-1000 is molded PC-ABS / PA6-GF30.

| Shell | Material | Spec | Pieces | Unit mass (kg) | Unit $ (qty 1) | Unit $ (qty 1k) |
|---|---|---|---:|---:|---:|---:|
| foot_shell (2-piece clamshell) | 30% glass-filled nylon 6 (injection molded) | wall 2.5 mm, shell mass 267 g | 2 | 0.267 | $41.73 | $11.23 |
| forearm_shell (2-piece clamshell) | PC-ABS blend (injection molded) | wall 2.5 mm, shell mass 212 g | 2 | 0.212 | $38.12 | $7.62 |
| hand_shell (2-piece clamshell) | PC-ABS blend (injection molded) | wall 2.5 mm, shell mass 160 g | 2 | 0.160 | $37.35 | $6.85 |
| head_shell (2-piece clamshell) | PC-ABS blend (injection molded) | wall 2.5 mm, shell mass 319 g | 1 | 0.319 | $39.68 | $9.18 |
| hip_pitch_shell (2-piece clamshell) | 30% glass-filled nylon 6 (injection molded) | wall 3.0 mm, shell mass 139 g | 2 | 0.139 | $38.49 | $7.99 |
| hip_roll_shell (2-piece clamshell) | 30% glass-filled nylon 6 (injection molded) | wall 3.0 mm, shell mass 128 g | 2 | 0.128 | $38.23 | $7.73 |
| neck_shell (2-piece clamshell) | PC-ABS blend (injection molded) | wall 2.5 mm, shell mass 78 g | 1 | 0.078 | $36.15 | $5.65 |
| pelvis_shell (2-piece clamshell) | 30% glass-filled nylon 6 (injection molded) | wall 3.0 mm, shell mass 809 g | 1 | 0.809 | $55.38 | $24.88 |
| shank_shell (2-piece clamshell) | 30% glass-filled nylon 6 (injection molded) | wall 3.0 mm, shell mass 635 g | 2 | 0.635 | $51.00 | $20.50 |
| shoulder_shell (2-piece clamshell) | PC-ABS blend (injection molded) | wall 2.5 mm, shell mass 89 g | 2 | 0.089 | $36.30 | $5.80 |
| thigh_shell (2-piece clamshell) | 30% glass-filled nylon 6 (injection molded) | wall 3.0 mm, shell mass 797 g | 2 | 0.797 | $55.08 | $24.58 |
| torso_shell (2-piece clamshell) | 30% glass-filled nylon 6 (injection molded) | wall 3.0 mm, shell mass 2144 g | 1 | 2.144 | $89.04 | $58.54 |
| upper_arm_shell (2-piece clamshell) | PC-ABS blend (injection molded) | wall 2.5 mm, shell mass 271 g | 2 | 0.271 | $38.99 | $8.49 |

## Mass reconciliation vs sim model

| Source | Mass (kg) |
|---|---:|
| Structural shells (PA6-GF30 + PC-ABS) | 9.21 |
| Off-the-shelf actuators (25) | 13.58 |
| Electronics + battery (lumped in sim) | 3.36 |
| **Sim mass model total** | **26.15** |
| + bearings / fasteners / wear pads (BOM-only) | 1.50 |
| **BOM total** | **27.65** |

