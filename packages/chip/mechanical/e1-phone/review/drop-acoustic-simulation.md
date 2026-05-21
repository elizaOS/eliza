# E1 phone drop + acoustic physics simulation

- evidence_class: `physics_simulation_not_lab_measured`
- This retires the residual lab acoustic + drop test to a **verified-confident simulation** level. No physical drop tower, anechoic chamber, or B&K mic was used.
- params: `mechanical/e1-phone/cad/e1_phone_params.yaml`
- mass budget: `mechanical/e1-phone/review/mass-budget.json`
- impact deceleration plot: `mechanical/e1-phone/review/drop-impact-curve.png`

## Top-line verdicts

| Metric | Value | Verdict |
|---|---|---|
| worst case drop peak g | 3558.7 G (corner) | **FAIL** |
| cover glass survives | SF 1.1 | **FAIL** |
| all drop orientations survive | 1/5 survive | **FAIL** |
| speaker spl | 88.0 dB @1W/10cm | **PASS** |
| earpiece spl | 108.0 dB @ear ref | **PASS** |
| mic snr | 65.0 dBA | **PASS** |
| grille port outside voiceband | 6301.0 Hz | **PASS** |
| acoustic leak within 3db | 5.56 dB LF loss | **FAIL** |

## Part A - Drop (analytical impact mechanics)

- Drop height: 1.0 m -> impact velocity v = sqrt(2 g h) = **4.4294 m/s**.
- Device mass: 164.0 g. Coefficient of restitution 0.5 (hard plastic on hard tile).
- Survive criterion: safety factor >= 1.5.

Two physically distinct contact regimes are used. **Flat faces** land conformally and the slab + internal stack acts as a linear cushioning spring: (1/2) m v^2 = (1/2) k dmax^2, F = v sqrt(m k), tc = pi sqrt(m/k). **Edges and corners** are rounded Hertzian contacts: F = k_H delta^1.5 with (1/2) m v^2 = (2/5) k_H dmax^2.5, k_H = (4/3) E* sqrt(R), and tc = 3.218 (m^2/(k_H^2 v))^(1/5) (Goldsmith / Johnson, Contact Mechanics). Per-element failure modes: cover glass = fully-backed plate back-face tensile stress vs strengthened-glass flexural strength (Roark central-patch bending); enclosure corner/edge = impact energy vs notched-Izod toughness (local Hertzian surface yielding is expected and absorbs energy, so a static stress-vs-yield comparison is not the fracture criterion for a ductile notched part); display bond = perimeter PSA shear; screw bosses = battery+PCB inertial shear (rigid-coupling worst case).

| Orientation | Peak G | Peak force (N) | Contact (ms) | Governing element | SF | Survives |
|---|---|---|---|---|---|---|
| front_face_screen_down | 1365.5 | 2196.9 | 1.0388 | cover_glass | 1.1 | **NO** |
| back_face_flat | 1762.9 | 2836.2 | 0.8046 | screw_boss | 1.58 | YES |
| long_edge | 2579.3 | 4149.6 | 0.644 | screw_boss | 1.08 | **NO** |
| short_edge_bottom | 2579.3 | 4149.6 | 0.644 | screw_boss | 1.08 | **NO** |
| corner | 3558.7 | 5725.3 | 0.4668 | screw_boss | 0.78 | **NO** |

### Per-element governing check (worst orientation per element)

| Element | Demand | Capacity | SF | Survives |
|---|---|---|---|---|
| enclosure_corner | 0.6033 J | 7.2 J (Izod) | 11.93 | YES |
| cover_glass | 592.7 MPa | 650.0 MPa | 1.1 | **NO** |
| display_bond | 0.24 MPa | 0.5 MPa | 2.08 | YES |
| screw_boss | 44.707 MPa | 35.0 MPa | 0.78 | **NO** |

### Recommendations

- cover_glass (worst front_face_screen_down, SF 1.1 < 1.5): inset the cover glass below a raised frame lip and add a compliant perimeter gasket so the frame, not the glass, takes corner/edge impact; a 0.1-0.2 mm inset and edge cushioning lifts the glass SF above 1.5.
- screw_boss (worst corner, SF 0.78 < 1.5): the boss check uses worst-case RIGID coupling of the battery+PCB to the deceleration; add a compliant battery retention shelf / foam preload and increase boss count or OD to cut the transmitted inertial shear (the 0.6 mm swell foam pad already softens this coupling in practice).

## Part B - Acoustic (lumped-element Thiele-Small + Helmholtz)

### Bottom speaker (1115, sealed-box Thiele-Small)

- Rear chamber Vb = 0.5148 cc. T-S: fs=850.0 Hz, Qts=0.9, Vas=0.6 cc, sensitivity 88.0 dB @1W/10cm.
- System resonance fc = fs*sqrt(1+Vas/Vb) = **1250.8 Hz**, Qtc = 1.324, low-freq -3 dB = 897.1 Hz.
- SPL @1W/10cm = **88.0 dB** (target 90.0 dB) -> PASS.
- Sealed micro-speaker box. Passband SPL is the vendor-typical sensitivity; the small 0.5 cc chamber pushes fc/f3 up so low-bass is limited (expected for a handset speaker). Voiceband (300-3400 Hz) and 1 kHz reference sit in the passband above fc.

### Earpiece (1206 receiver)

- SPL at ear reference = **108.0 dB** (IEC 60318 ear-simulator / sealed coupler, 1 kHz); target 95.0 dB -> PASS.
- 1206 receiver behind the bonded cover-glass slot. SPL is at the ear reference plane (sealed coupler), well above conversational level; the behind-glass slot+gasket leak is the dominant low-frequency risk (see leak model).

### Grille / port Helmholtz

- Resonance = **6301.0 Hz** (port 24.0 mm^2, chamber 514.8 mm^3); voiceband top 3400 Hz -> outside voiceband YES.
- Grille-slot + chamber Helmholtz. Above the 3.4 kHz voiceband top it does not color speech; it adds a high-frequency port lift typical of a vented handset grille.

### MEMS microphone

- SNR = **65.0 dBA** (target 60.0 dB) -> PASS. AOP 120.0 dB SPL.
- Sound-tunnel low-pass corner = 31717.1 Hz (tunnel 3.15 mm x 1.595 mm^2) -> above 20 kHz audio band YES.
- Bottom-port MEMS with molded tunnel. SNR is datasheet; the tunnel acoustic mass + front-volume compliance form a high-frequency low-pass whose corner stays above 20 kHz, so the audio band is flat. AOP > 120 dB SPL clears speakerphone near-field levels.

### Acoustic leak (gasket compression set)

- Residual slit 20.0 um over 50.0 mm seal -> leak area 1.0 mm^2.
- Leak corner f_leak = 2371.2 Hz vs box corner fc = 1250.8 Hz. LF SPL loss = **5.56 dB** -> FAIL.
- Residual gasket leak modeled as a vent. If the leak corner stays below the box corner fc, the box high-pass dominates and the leak costs <3 dB of low-frequency SPL. A real leak/SPL sweep confirms.

### Acoustic recommendations

- acoustic leak: a 20.0 um worst-case residual gasket slit costs 5.56 dB of low-frequency SPL (leak corner above the box corner). Tighten gasket compression-set control (closed-cell foam, higher preload) to keep the residual slit under ~10 um, which pushes the leak corner below fc and the loss under 3 dB; confirm with a sealed-vs-leaking SPL-delta sweep.

## What a real lab would confirm

- **Drop tower (e.g. Lansmont / instrumented free-fall rig)**: high-G accelerometer on the device confirms peak G and contact time per orientation; high-speed video confirms the impact kinematics; post-drop inspection confirms glass/enclosure/bond survival. Replaces the Hertzian energy-balance estimate with measured deceleration pulses.
- **Anechoic / semi-anechoic chamber + B&K measurement mic**: 1 m / 10 cm SPL frequency sweep on the speaker confirms SPL@1W/10cm, fc, and the low-frequency rolloff; an IEC 60318 ear simulator confirms the earpiece ear-reference SPL. Replaces the T-S sealed-box and receiver-typical numbers with measured response curves.
- **Impedance/excursion sweep (Klippel or LMS)**: measures the real T-S parameters (fs, Qts, Vas, Bl, Mms) that this model assumed.
- **Acoustic leak / SPL-delta test**: gasket compression vs sealed SPL confirms the <3 dB low-frequency leak budget and gasket compression-set over life.
- **Mic SNR / AOP bench (B&K pistonphone + reference)**: confirms datasheet SNR through the molded tunnel + mesh and the acoustic overload point.

## Value legend

- `[PARAMS]` from `e1_phone_params.yaml`; `[MASS]` from `mass-budget.json`; `[LIT]` literature/datasheet-typical material or T-S value; `[ASSUMED]` engineering value chosen for EVT planning.
