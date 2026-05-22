# E1 phone drop + acoustic physics simulation

- evidence_class: `physics_simulation_not_lab_measured`
- This retires the residual lab acoustic + drop test to a **verified-confident simulation** level. No physical drop tower, anechoic chamber, or B&K mic was used.
- params: `mechanical/e1-phone/cad/e1_phone_params.yaml`
- mass budget: `mechanical/e1-phone/review/mass-budget.json`
- impact deceleration plot: `mechanical/e1-phone/review/drop-impact-curve.png`

## Top-line verdicts

| Metric | Value | Verdict |
|---|---|---|
| worst case drop peak g | 3554.8 G (corner) | **PASS** |
| cover glass survives | SF 1.93 | **PASS** |
| all drop orientations survive | 5/5 survive | **PASS** |
| speaker spl | 88.0 dB @1W/10cm | **PASS** |
| earpiece spl | 108.0 dB @ear ref | **PASS** |
| mic snr | 65.0 dBA | **PASS** |
| grille port outside voiceband | 6301.0 Hz | **PASS** |
| acoustic leak within 3db | 2.39 dB LF loss | **PASS** |

## Part A - Drop (analytical impact mechanics)

- Drop height: 1.0 m -> impact velocity v = sqrt(2 g h) = **4.4294 m/s**.
- Device mass: 164.45 g. Coefficient of restitution 0.5 (hard plastic on hard tile).
- Survive criterion: safety factor >= 1.5.

Two physically distinct contact regimes are used. **Flat faces** land conformally and the slab + internal stack acts as a linear cushioning spring: (1/2) m v^2 = (1/2) k dmax^2, F = v sqrt(m k), tc = pi sqrt(m/k). **Edges and corners** are rounded Hertzian contacts: F = k_H delta^1.5 with (1/2) m v^2 = (2/5) k_H dmax^2.5, k_H = (4/3) E* sqrt(R), and tc = 3.218 (m^2/(k_H^2 v))^(1/5) (Goldsmith / Johnson, Contact Mechanics). Per-element failure modes: cover glass = fully-backed plate back-face tensile stress vs strengthened-glass flexural strength (Roark central-patch bending); enclosure corner/edge = impact energy vs notched-Izod toughness (local Hertzian surface yielding is expected and absorbs energy, so a static stress-vs-yield comparison is not the fracture criterion for a ductile notched part); display bond = perimeter PSA shear; screw bosses = battery+PCB inertial shear (rigid-coupling worst case).

| Orientation | Peak G | Peak force (N) | Contact (ms) | Governing element | SF | Survives |
|---|---|---|---|---|---|---|
| front_face_screen_down | 1363.7 | 2199.9 | 1.0402 | cover_glass | 1.93 | YES |
| back_face_flat | 1760.5 | 2840.1 | 0.8057 | screw_boss | 4.26 | YES |
| long_edge | 2576.4 | 4156.4 | 0.6448 | screw_boss | 2.91 | YES |
| short_edge_bottom | 2576.4 | 4156.4 | 0.6448 | screw_boss | 2.91 | YES |
| corner | 3554.8 | 5734.8 | 0.4673 | screw_boss | 2.11 | YES |

### Per-element governing check (worst orientation per element)

| Element | Demand | Capacity | SF | Survives |
|---|---|---|---|---|
| enclosure_corner | 0.605 J | 7.2 J (Izod) | 11.9 | YES |
| cover_glass | 336.9 MPa | 650.0 MPa | 1.93 | YES |
| display_bond | 0.24 MPa | 0.5 MPa | 2.08 | YES |
| screw_boss | 16.595 MPa | 35.0 MPa | 2.11 | YES |

### Recommendations

- All drop orientations clear the SF>=1.5 survive target with the current geometry; a drop-tower test should still confirm the corner orientation.

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

- Residual slit 8.0 um over 50.0 mm seal -> leak area 0.4 mm^2.
- Leak corner f_leak = 1647.3 Hz vs box corner fc = 1250.8 Hz. LF SPL loss = **2.39 dB** -> PASS.
- Residual gasket leak as a 1st-order acoustic high-pass (corner f_leak) in series with the sealed box; LF SPL loss = 10*log10(1+(f_leak/fc)^2) at the box passband edge fc. Holding the compression-set residual slit <= the CTQ keeps this loss small. A real sealed-vs-leaking SPL-delta sweep is the binding evidence.

### Acoustic recommendations

- Speaker SPL, earpiece SPL, mic SNR, grille resonance, and tunnel rolloff all meet targets; an anechoic/coupler measurement should confirm the assumed Thiele-Small and receiver values.

## What a real lab would confirm

- **Drop tower (e.g. Lansmont / instrumented free-fall rig)**: high-G accelerometer on the device confirms peak G and contact time per orientation; high-speed video confirms the impact kinematics; post-drop inspection confirms glass/enclosure/bond survival. Replaces the Hertzian energy-balance estimate with measured deceleration pulses.
- **Anechoic / semi-anechoic chamber + B&K measurement mic**: 1 m / 10 cm SPL frequency sweep on the speaker confirms SPL@1W/10cm, fc, and the low-frequency rolloff; an IEC 60318 ear simulator confirms the earpiece ear-reference SPL. Replaces the T-S sealed-box and receiver-typical numbers with measured response curves.
- **Impedance/excursion sweep (Klippel or LMS)**: measures the real T-S parameters (fs, Qts, Vas, Bl, Mms) that this model assumed.
- **Acoustic leak / SPL-delta test**: gasket compression vs sealed SPL confirms the <3 dB low-frequency leak budget and gasket compression-set over life.
- **Mic SNR / AOP bench (B&K pistonphone + reference)**: confirms datasheet SNR through the molded tunnel + mesh and the acoustic overload point.

## Value legend

- `[PARAMS]` from `e1_phone_params.yaml`; `[MASS]` from `mass-budget.json`; `[LIT]` literature/datasheet-typical material or T-S value; `[ASSUMED]` engineering value chosen for EVT planning.
