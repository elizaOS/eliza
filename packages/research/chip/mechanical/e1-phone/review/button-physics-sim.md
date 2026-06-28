# E1 phone side-button physics simulation

- evidence_class: `simulation_for_evt_planning_not_measured`
- datasheet: Panasonic EVQ-P7 series light-touch tactile switch
  - https://na.industrial.panasonic.com/products/switches-encoders-interface-devices/switches/light-touch-tactile-switches/series/79247
- params: `mechanical/e1-phone/cad/e1_phone_params.yaml`
- F-x plot: `mechanical/e1-phone/review/button-force-displacement.png`

## Verdicts

| Check | Verdict |
|---|---|
| actuation before hard stop | **PASS** |
| no rest preload | **PASS** |
| contact pressure within limit | **PASS** |
| single end rocker actuation | **PASS** |
| ip54 gasket preload | **PASS** |
| fatigue life margin | **PASS** |

## Force-displacement (tactile dome)

| Button | Peak force (N) | @ disp (mm) | Snap force (N) | Hard stop (mm) |
|---|---|---|---|---|
| power | 1.5992 | 0.2499 | 0.88 | 0.35 |
| volume | 1.4992 | 0.2499 | 0.825 | 0.35 |

Pre-travel rises linearly to the operating-force peak, the metal dome buckles (snap/click, force drops to the return level), then a steep post-travel hard-stop rise. Peaks are [DATASHEET]; snap zone and hard-stop stiffness are [ASSUMED].

## Cap mechanics & contact pressure

Pressure limit (cap-to-skin comfort): **0.2 N/mm^2**.

| Button | Cap face (mm^2) | Skin pressure (N/mm^2) | Rib->dome (N/mm^2) | Dome top (N/mm^2) |
|---|---|---|---|---|
| power | 24.0 | 0.125 | 1.9753 | 0.7111 |
| volume | 42.0 | 0.07143 | 1.8519 | 0.6667 |

The cap distributes a deliberate finger press over its full face, so cap-to-skin pressure stays well under the 0.2 N/mm^2 comfort limit. Rib-to-dome and dome-top pressures are switch-internal contact (operating force concentrated on the rib tip / dome crown), reported for completeness; they are not bounded by the skin-comfort limit and are within the EVQ-P7 operating envelope.

## Travel stack

| Button | Cap proud (mm) | Rest clearance (mm) | Lost motion (mm) | Actuation (mm) | Hard stop (mm) |
|---|---|---|---|---|---|
| power | 0.3 | 0.02 | 0.02 | 0.27 | 0.35 |
| volume | 0.3 | 0.02 | 0.02 | 0.27 | 0.35 |

Cap rests with positive clearance to the dome (no rest pre-load), the dome reaches its actuation/buckling point before the hard stop, and lost motion stays under 0.1 mm.

## Volume rocker

- Dome offset from center: 7.5 mm (pivot: center of rocker cap).
- Tilt at full travel: 2.6719 deg.
- Far dome displacement when one end pressed: -0.35 mm (threshold 0.25 mm) -> single-end actuation OK. Pressing one end pivots the rocker about its center, lifting the far dome away from actuation.

## Gasket (IP54 seal)

IP54 splash seal threshold: 0.05 N/mm^2 [ASSUMED].

| Button | Shore A | Modulus (MPa) | Seal pressure (N/mm^2) | Web k (N/mm) | Force added (N) | IP54 |
|---|---|---|---|---|---|---|
| power | 50.0 | 2.4661 | 0.6165 | 0.3274 | 0.1146 | PASS |
| volume | 50.0 | 2.4661 | 0.6165 | 0.5378 | 0.1882 | PASS |

Elastomer compression preloads the labyrinth seal above the IP54 splash threshold while adding only a small fraction of the operating force to the button feel. Shore A, membrane skirt geometry and compression are [ASSUMED].

## Fatigue

- Rated life: 100000 cycles (EVQ-P7 series 100k cycle minimum; 200k for low-force options) [DATASHEET].
- Design target: 50000 cycles [ASSUMED] -> margin 2.0x (PASS).
- Dome operating force ~1.6 N is within EVQ-P7 rated operating-force envelope; cycling below rated stroke and force keeps dome contact stress under the metal-dome fatigue limit (qualitative).

## Dynamic response (1-DOF cap)

| Button | Cap mass (g) | Natural freq (Hz) | Damping ratio | Settle 2% (ms) | Debounce (ms) |
|---|---|---|---|---|---|
| power | 0.3 | 735.11 | 0.35 | 2.474 | 4 |
| volume | 0.52 | 540.62 | 0.35 | 3.364 | 6 |

Cap modeled as a mass on the dome return spring with elastomer damping. The recommended firmware debounce window exceeds the 2% settle time. Cap mass, damping ratio and finger force are [ASSUMED].
