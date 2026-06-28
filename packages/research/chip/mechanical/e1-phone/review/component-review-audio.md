# E1 Phone — Audio Component Manufacturability Review

Scope: EVT0 design review (revision `evt0-mechanical-cad-flush-back`, 78.0 x 153.6 x
11.8 mm, flush flat back). Reviewer discipline: acoustics / audio hardware. This is an
**EVT design-review verdict, not a production release**. All SPL / SNR / leak numbers
remain lab-test blockers per `acoustic-validation.md`; this review covers part selection,
purchasability, tolerances, spacing, neighbor interaction, occlusion, and the bottom-edge
congestion question.

Evidence sources: `cad/e1_phone_params.yaml`, `design-change-flush-back.md`,
`acoustic-validation.{md,json}`, `full-cad-min-gap-matrix.csv`,
`kicad-placement-reconciliation.json`, and the part research below (real datasheets /
distributor pages via web search).

---

## 1. BOTTOM SPEAKER — 1115 micro speaker module (15.0 x 11.0 x 3.5 mm)

**Off-the-shelf recommendation:** Goertek **1115F**-class box speaker (15 x 11 x 3.5 mm,
8 Ohm, 1 W rated, F0 ~850 Hz). This exact 1115 form factor is a commodity
bottom-firing handset box speaker — Goertek 1115F is documented as a shipping bottom
speaker, AAC has the equivalent 1115 box class, and the bare 1511/1115 driver
(15x11x3.5 mm, 8 Ohm 1 W) is sold openly. Chinese sources: Goertek / AAC direct, plus
Shenzhen Qianhai Wuxing Semiconductor and the open 1115/1511 driver market.
Price @100k: bare 1115 driver ~$0.30–0.55; integrated box module with rear chamber
~$0.85–1.40.

**Verdict: MANUFACTURABLE (off-the-shelf, EVT-ready).**

- Chamber vs SPL: modeled rear chamber 0.515 cm3 ≥ 0.40 cm3 EVT target (PASS in CAD).
  For a 1115 box class this is enough to support a >=72 dB SPL @1 kHz target, but SPL/
  impedance sweep through the molded chamber is still a lab blocker — chamber is at the
  low end for strong low-mid output; do not promise loud media playback until measured.
- Grille slots on -Y bottom face: 5 slots, 24.0 mm2 open area, 0.145 open-area ratio
  (>=5 slots, >=0.035 ratio target) — PASS. Five molded slots are well within injection-
  mold capability at 1.15 mm wall.
- Port mesh: hydrophobic dust mesh modeled over the grille (PASS). Mesh is a die-cut
  acoustic-mesh insert (commodity), not molded-in — confirm assembly tape/heat-stake.
- Sealing gasket + rear chamber: chamber wall is part of the molded shell; needs a
  perimeter foam/rubber gasket against the module face. Leak delta target 0–3 dB is a
  lab blocker.

**Margins/tolerances:** module 15.0 x 11.0 x 3.5 mm against a molded pocket; with the
process stack (~0.21 mm RSS placement+mold) plan +0.30 mm pocket clearance and a
compressible gasket to absorb it.

**Spacing / neighbor interaction:** speaker-to-USB-C 6.53 mm (target >=1.0 mm — PASS,
comfortable); speaker-to-haptic LRA 8.3 mm (PASS, but the X-LRA is the main vibration
neighbor — keep the speaker chamber gasket decoupled from the LRA bracket);
speaker-to-bottom-mic 27.25 mm (PASS, good acoustic isolation).

**Occlusion / collision:** none. Bottom-firing slots on -Y; no part crosses the grille.
USB-C reinforcement saddle is 0.5 mm from the chamber wall — tight but non-colliding;
verify the saddle does not breach the chamber seal.

**Open issues:** (a) chamber volume at low end — measure SPL before committing acoustic
claims; (b) confirm gasket compression set over life; (c) decouple from LRA.

---

## 2. EARPIECE RECEIVER — 1206 receiver behind cover-glass slot (12.0 x 6.0 x 2.5 mm)

**Off-the-shelf recommendation:** Goertek / AAC **1206-class dynamic receiver**
(moving-coil handset receiver, ~12 x 6 x 2.5 mm). Goertek and AAC both list miniature
moving-coil receivers in this footprint as standard handset parts; the 12x6x2.5 mm
envelope is a mainstream receiver size. Chinese sources: Goertek / AAC direct, plus the
open Shenzhen receiver-module market (10–12 mm dynamic receiver/earpiece modules sold
on Alibaba). Price @100k: ~$0.45–0.90 (bare receiver), ~$1.10–1.60 (gasketed module).

**Verdict: MANUFACTURABLE (off-the-shelf, EVT-ready).**

- Acoustic slot on +Z front at top: modeled slot area 16.0 mm2 (>=10 mm2 target — PASS).
- Mesh: handset acoustic mesh modeled (PASS) — commodity die-cut acoustic mesh.
- Gasket: 0.55 mm gasket, within the 0.4–0.8 mm window (PASS). The receiver couples to
  the cover-glass slot through a compressed perimeter gasket — standard behind-glass
  handset stack.
- Clearance to front camera + top mic: receiver-to-front-camera 11.3 mm (PASS, generous);
  receiver-to-top-mic 10.25 mm (PASS). Top of phone is uncongested.
- Leak path: behind-glass slot through a thin cover-glass channel is the classic leak
  risk. Leak delta 0–3 dB is a lab blocker; the gasket must seal against bonded glass.

**Margins/tolerances:** 0.55 mm gasket gives ~0.15–0.25 mm of usable compression travel
to absorb the z-stack tolerance behind bonded glass — adequate but the tightest acoustic
seal on the device; control glass bond-line and gasket compression-set together.

**Spacing / neighbor interaction:** front camera and top mic both >10 mm away — no
acoustic crosstalk concern at the top.

**Occlusion / collision:** none. Slot is on +Z under the top bezel; cover glass is
bonded clear of the slot channel.

**Open issues:** (a) behind-glass leak path is the dominant earpiece risk — needs lab
leak/SPL through the compressed gasket; (b) verify slot channel does not telegraph
through the bonded glass cosmetically.

---

## 3. BOTTOM MIC — MEMS 3.5 x 2.65 x 1.0 mm, molded sound tunnel to -Y

**Off-the-shelf recommendation:** Goertek **S08OB381** series bottom-port analog MEMS
(SMD package 3.50 x 2.65 x ~0.98 mm) — an exact match for the 3.5x2.65x1.0 mm envelope.
Real, stocked part (Goertek S08OB381-026 = LCSC/JLCPCB C2684423; S15OB381-050 etc. on
LCSC/DigiKey). For a digital variant use Goertek S15OB381 (bottom-port digital).
Knowles / AAC offer pin-compatible bottom-port equivalents as second source. Chinese
sources: LCSC, JLCPCB, Goertek direct. Price @100k: ~$0.10–0.22.

**Verdict: MANUFACTURABLE (off-the-shelf, EVT-ready).**

- Tunnel: molded sound tunnel to -Y bottom face — 2 ports, 1.595 mm2 total port area
  (>=2 ports, >=1.0 mm2 target — PASS).
- Port on bottom face: on -Y, adjacent to the speaker grille set, sealed to the MEMS
  port via gasket.
- Clearance to USB-C / speaker: mic-to-USB-C 11.78 mm (>=1.0 mm load-path separation
  target — PASS, very comfortable); mic-to-speaker 27.25 mm (PASS, far enough that
  speaker back-pressure will not desensitize the mic). Mic-to-side-frame 5.725 mm (PASS).
- Sealing: needs MEMS-port gasket + hydrophobic mesh (2 meshes modeled — PASS).

**Margins/tolerances:** tunnel length is the acoustic risk, not collision — a long molded
tunnel rolls off high-frequency response and adds particulate trapping. Keep the tunnel
as short and straight as the -Y porting allows; current 11.78 mm USB separation gives
room to shorten the tunnel. Port-to-MEMS alignment needs the standard ~0.2 mm gasket
registration.

**Spacing / neighbor interaction:** no acoustic conflict; the >=1 mm USB load-path
separation is met by a 10x margin.

**Occlusion / collision:** none. Verify the molded tunnel does not intersect the USB-C
reinforcement saddle (saddle sits between USB and speaker, not over the mic tunnel).

**Open issues:** (a) tunnel length vs HF roll-off and dust trapping — minimize; (b) SNR
through the molded tunnel + mesh is a lab blocker (target >=60 dB).

---

## 4. TOP MIC — noise-cancel MEMS 3.5 x 2.65 x 1.0 mm, port on +Y top face

**Off-the-shelf recommendation:** Goertek **S15OT421** series **top-port digital** MEMS
(real, stocked: S15OT421-001 = JLCPCB C5160216; S15OT421-005 = C2684419; S15OT421-017
on DigiKey/LCSC), SNR ~59–64 dB. For a top-port part matching the 3.5x2.65 footprint use
the larger S15OT421 package; the noise-cancel reference mic should be the **same MEMS
model as the bottom mic** for matched sensitivity/phase (use S15OB/S15OT bottom+top pair
from one vendor lot). Chinese sources: LCSC, JLCPCB, Goertek direct. Price @100k:
~$0.09–0.17.

**Verdict: MANUFACTURABLE (off-the-shelf, EVT-ready).**

- Port location: +Y top face — top-port mesh + port modeled (PASS); top-port MEMS suits a
  direct top-face port better than a bottom-port part with a tunnel, so part class is
  correct.
- Clearance to earpiece + front camera: top-mic-to-earpiece 10.25 mm (PASS);
  top-mic-to-front-camera 32.0 mm (PASS, generous).
- Distance from bottom mic for beamforming: top-to-bottom mic 134.55 mm. This is the full
  device length — excellent baseline for 2-mic beamforming / noise cancellation (large,
  well-defined spacing). Confirm the noise-cancel algorithm is tuned for ~135 mm baseline.

**Margins/tolerances:** standard top-port MEMS gasket registration (~0.2 mm). Port mesh
die-cut, commodity.

**Spacing / neighbor interaction:** matched-pair sensitivity with the bottom mic matters
more than spacing here — source both mics from one vendor lot to hold beamforming
matching. No acoustic crosstalk at the top (earpiece slot 10 mm away on +Z, mic port on
+Y).

**Occlusion / collision:** none.

**Open issues:** (a) match top+bottom mic sensitivity/phase via single-vendor lot;
(b) SNR/PDM integrity is a lab blocker (target >=60 dB).

---

## Bottom-edge fit assessment — DO USB-C + SPEAKER + BOTTOM MIC FIT?

**YES — they fit side by side on the 78 mm-wide bottom edge with clearance.** No
congestion clash found.

Geometry (PCB is 64 mm wide; bottom edge at Y≈129; CAD min-gap matrix):

- USB-C receptacle centered at X=34 mm (8.94 mm wide); audio block (codec + speaker +
  bottom mic) bottom-left at X≈14 mm. Layout is mic + speaker on the left third, USB-C
  centered — they do not stack.
- Speaker module ↔ USB-C receptacle: **6.53 mm** clear (target >=1.0 mm).
- Bottom mic ↔ USB-C receptacle: **11.78 mm** clear (target >=1.0 mm load-path sep).
- Speaker module ↔ bottom mic: **27.25 mm** clear.
- USB-C reinforcement saddle ↔ speaker chamber: 0.5 mm (tight, non-colliding — flag for
  seal verification, not a clash).

Across the 78 mm bottom edge the three -Y features occupy roughly: bottom mic (~3.5 mm) +
gap + speaker (~15 mm) on the left, USB-C aperture (~9 mm) centered, leaving margin to
both side frames. **No collision; comfortable acoustic and mechanical separation.**

---

## Blockers

**No design blocker for EVT.** All four parts are real, purchasable off-the-shelf Chinese
parts and the bottom edge fits with margin. Remaining items are the standard
**lab-measurement blockers** already tracked in `acoustic-validation.md` (speaker SPL/
impedance, mic SNR through molded tunnel/mesh, earpiece SPL/leak through behind-glass
gasket, ingress review) — these gate production release, not the EVT design.

**Watch-items (not blockers):** speaker rear chamber at the low end of its volume target
(measure SPL before acoustic claims); bottom-mic molded tunnel length (minimize for HF +
dust); USB saddle-to-speaker-chamber 0.5 mm seal verification; match top/bottom mic
lots for beamforming.
