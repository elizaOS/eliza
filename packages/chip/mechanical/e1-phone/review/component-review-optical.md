# E1 phone optical component review (EVT design review)

Scope: rear camera, front camera, rear torch/flash LED, screen/display. Validated
against the locked `evt0-mechanical-cad-flush-back` requirements: 11.8 mm thick,
fully flush flat back (no bump, no proud ring), rear camera + torch buried behind
flush internal windows, SINGLE lens each direction. This is an EVT-stage design
review for sourcing/layout planning — NOT a production-release sign-off.

Reference inputs: `cad/e1_phone_params.yaml`, `review/design-change-flush-back.md`,
`board/kicad/e1-phone/preliminary-bom.yaml`, `review/bom-unit-cost.yaml`, and
the current `review/full-cad-boolean-interference.json` concept-envelope B-rep
run.

Z-stack reminder (origin at mid-plane, +Z toward screen): back outer plane
-5.900 mm, back inner wall -4.700 mm, 1.15 mm back wall, 0.40 mm current
boolean burial clearance over the rear camera module. This review remains
EVT planning evidence only; release credit still requires routed-board STEP and
supplier B-rep reruns through the enclosure gate.

---

## 1. Rear camera — single 13 MP simple-AF, buried behind flush back glass

**Recommended MPN:** Sincere First (Guangzhou Sincere Information Technology Ltd.)
OV13B10 13 MP autofocus MIPI CSI-2 FPC module — replaces the spec's OV13855
placeholder with a current-production, lower-Z sensor in the same 13 MP class.
The OV13B is the latest OmniVision 13 MP part (1/3.06", 1.12 µm pixel, 4-lane MIPI,
4K30 / 1080p60). Sincere First explicitly offers an **8.5 × 8.5 mm AF main-camera
module with Z height below 4 mm** on this sensor, and stocks pin-compatible
OV13855 / OV13850 / OV13858 builds on the same FPC.

- **Chinese source:** sincerefirst.en.made-in-china.com / cameramodule.com (OV13B10
  AF FPC module). Sunny Optical / Q-Tech reference modules are pin-class alternates.
- **Price @100k:** ~$3.90 (BOM line 15; OV13B10 trades within ±$0.20 of OV13855).
- **Verdict: YES (conditional on vendor z-height + lens-axis drawing).**

**Margins & tolerances:**
- Module height budget is 5.1 mm in spec; OV13B10 AF module ships at Z < 4.0 mm,
  giving ~1.1 mm of unused z-headroom — burial is comfortable, not marginal.
- Current local CAD burial clearance to back inner wall = 0.40 mm (module back
  face Zmin -4.300 mm vs inner wall -4.700 mm). With a sub-4 mm module the back face can sit deeper,
  raising clearance to ~1.4 mm. Reduce the modeled 5.1 mm envelope to the real
  module z once the vendor drawing lands.
- Flush window (`rear_camera_glass`, 9.2 × 9.2 × 0.55) outer face coplanar with
  back outer plane; cosmetic flush tolerance `rear_camera_window_flush_to_back_mm`
  = 0.0 ±0.05. Window flatness must hold ±0.05 mm so the sapphire/glass insert
  never reads proud — tight but standard for a recessed bonded insert.
- Optical path: lens diameter 6.8 mm vs 9.2 mm window aperture leaves ~1.2 mm
  radial margin. Window inner face at -5.050 mm vs module front face +0.950 mm —
  ~6.0 mm air/baffle column. That column MUST be a blackened molded baffle (anti-
  reflective, draft-relieved) to control stray-light flare; an open cavity will
  veil the image.

**Spacing & neighbor interaction:**
- Adjacent: rear torch LED (see §3), back wall, battery directly inboard.
- MIPI: 4-lane CSI-2 → 24-to-30-pin camera FPC connector (BOM dependency). Confirm
  SoC (Unisoc T606) CSI lane count supports 4 lanes at 13 MP full res.
- Needs `rear_camera_alignment_pin` fixturing (per tolerance block) to hold lens
  axis under the 9.2 mm window; placement budget 0.05 mm.

**Occlusion / collision risk:**
- Camera-vs-battery burial: battery back face -4.300 mm clears inner wall -4.450 mm
  by only **0.15 mm**. The camera module sits behind/beside the PCB, not over the
  battery, so they don't stack — but the 0.15 mm battery-to-wall gap is the
  tightest z-clearance in the device and must be protected by a keepout so a
  swollen/charged pouch (typical 6-8% thickness growth over life) cannot bear on
  the camera or back wall. **Open issue.**
- Flash crosstalk: see §3 — primary occlusion concern.

**Open issues / blockers:**
- Vendor z-height + lens-axis + OTP-calibration drawing (freeze blocker, BOM).
- Confirm internal baffle/dust seal design between module and flush window.
- Validate battery pouch swell keepout vs 0.15 mm wall gap.

---

## 2. Front camera — single 5 MP fixed-focus behind cover glass

**Recommended MPN:** Sincere First SF-G5035S60FY (GalaxyCore GC5035, 5 MP fixed-
focus, MIPI) — matches spec class (GC5035/GC02M1/OV5675). GC5035 is China-domestic
(GalaxyCore), 2-lane MIPI, well inside the 6.5 × 6.5 × 3.2 mm modeled envelope.

- **Chinese source:** Sincere First / O-Film / Truly GC5035 FF reference module
  (Alibaba GC5035 5 MP listings).
- **Price @100k:** ~$1.10 (BOM line 16).
- **Verdict: YES.**

**Margins & tolerances:**
- z-stack behind 0.7 mm cover glass: cover glass 0.70 + adhesive 0.18 + air/FPC +
  module 3.2 mm fits the front layer budget with the screen at `z_from_front_mm`
  0.35. Lens diameter 3.4 mm vs module 6.5 mm — ample.
- Under-glass black-mask window: the bonded black cover-glass ink needs a clear
  aperture > 3.4 mm lens OD plus FOV cone; recommend ≥ 4.0 mm printed aperture
  with a clean ink edge (no halo) and AR on the inner glass face.

**Spacing & neighbor interaction:**
- Adjacent: earpiece receiver (12 × 6 × 2.5) and top MEMS mic (3.5 × 2.65 × 1.0)
  along the top edge. Front camera must sit in the top black-mask band without its
  FOV cone clipping the earpiece slot/gasket or mic tunnel. Recommend ≥ 2.0 mm
  edge-to-edge between the camera aperture and earpiece slot.
- MIPI: 2-lane CSI → small camera FPC connector.
- `front_camera_alignment_pin` fixturing required (tolerance block).

**Occlusion / collision risk:**
- Low. Single FF lens, no AF actuator, shallow z. Main risk is black-mask aperture
  misalignment causing vignette — controlled by the alignment pin + 0.05 mm
  placement budget.

**Open issues / blockers:**
- Exact pinout, lens-z, enclosure z-stack, driver support (freeze blockers, BOM).
- Confirm black-mask aperture diameter vs FOV cone with vendor lens drawing.

---

## 3. Rear torch / flash LED — newly added, buried behind flush light-pipe

**Recommended MPN:** Lumileds **LXCL-PWF1** LUXEON Flash (white): 1.64 × 0.90 mm
footprint, 1000 mA flash forward current, ~4.8 V Vf — a real, datasheet-backed
phone-flash part that fits the modeled 1.0 × 1.0 × 0.7 mm seat footprint margin and
the 1.6 × 1.6 mm flush window. OSRAM CEYW-class and Everlight top-view flash LEDs
are pin/size alternates; for cost-down a Chinese flash LED (MLW/Everlight class)
drops in. **Driver IC:** Awinic **AW36515** (I2C boost flash/torch driver, China-
domestic) or **AW36501** (1.5 A total) — both single-IC, I2C-controlled, Shenzhen-
stocked; SGM3140 is a simpler analog torch-only alternate.

- **Chinese source:** Lumileds LXCL via distributor; AW36515/AW36501 via Awinic /
  LCSC. Cost-down flash LED from Everlight/MLW Shenzhen channel.
- **Price @100k:** ~$0.15-0.25 LED + ~$0.20-0.35 driver IC (new BOM line; not yet
  in `bom-unit-cost.yaml` — **add it**).
- **Verdict: CONDITIONAL** — part fits, but flush light-pipe isolation from the
  camera is the gating design item (below).

**Margins & tolerances:**
- Footprint: LXCL-PWF1 1.64 × 0.90 mm vs seat envelope 1.0 × 1.0 × 0.7 mm — the
  modeled 1.0 mm seat is slightly undersized in one axis for this exact part;
  either widen the seat to ~1.7 × 1.0 mm or pick a 1.0 × 1.0 mm OSRAM CEYW-class
  emitter. **Reconcile in CAD.**
- Window: 1.6 × 1.6 × 0.5 mm flush light-pipe, outer face coplanar with back outer
  plane (-5.600 mm). LED seated on back inner wall -4.450 mm. Light pipe must be a
  walled, opaque-sided pipe (not an open hole) so flash light exits only -Z.
- Drive: typ 1 A flash / ~150-300 mA torch. Thermal: 1 A pulse into a buried LED on
  a 1.15 mm plastic wall — pulse duty is low so junction is fine, but verify pad
  copper / thermal via on the FPC; max skin temp target 43 °C.

**Spacing & neighbor interaction (camera-flash crosstalk — KEY CHECK):**
- The flash and camera both fire/expose through separate flush windows in the same
  flat back. The risk is flash light coupling into the camera optical path (lens
  flare / veiling glare) either through the back-glass plane or via internal
  reflection in the shared cavity.
- **Recommended minimum flash-to-camera spacing: ≥ 6.0 mm center-to-center**
  (LED window center to camera lens-axis center), with a hard floor of 5.0 mm. This
  is consistent with mainstream phones (flash typically 6-10 mm from the main lens)
  and is necessary here because BOTH windows are flush in one continuous back wall —
  there is no bump-edge step to break the light path.
- **Mandatory isolation regardless of spacing:** an opaque internal wall/baffle
  between the LED light-pipe column and the camera baffle column, plus an opaque
  (printed/ink) gap on the inner back-glass between the two windows. Flush windows
  in a single glass/glass-insert plane can light-pipe edge glow across to the camera
  aperture — the inter-window region must be optically black and physically septum'd.

**Occlusion / collision risk:**
- Crosstalk/flare is the dominant risk and is HIGHER than a bumped design because
  of the coplanar flush windows. Mitigation = spacing + septum + black inter-window
  mask (above). Treat as a blocker until a stray-light mock-up is shot.

**Open issues / blockers:**
- Reconcile LXCL-PWF1 1.64 × 0.90 footprint vs 1.0 × 1.0 seat (or pick CEYW-class).
- Add the LED + driver IC as explicit BOM lines (currently absent).
- Stray-light / flare validation build before DVT.
- Confirm ≥ 6.0 mm flash-to-lens spacing is actually laid out (not yet dimensioned
  in params — only "beside the rear camera").

---

## 4. Screen / display — 5.5" FHD MIPI LCD + CTP

**Recommended MPN:** Chenghao CH550FH01A-CT class 5.5" FHD (1080×1920) LTPS MIPI LCD
+ on-cell CTP, 40-pin FPC (per spec + BOM line 12). BOE / Tianma / META 055WU01 are
pin-compatible-class alternates.

- **Chinese source:** Chenghao (chenghaolcd.com) / BOE / Tianma; alternates per BOM.
- **Price @100k:** ~$11.80 (BOM line 12).
- **Verdict: YES (conditional on FPC drawing + init sequence + touch controller).**

**Margins & tolerances:**
- CTP outline 77.1 × 151.77 mm vs device 78.0 × 153.6 mm. Cover glass 77.1 × 151.77
  × 0.7. Active area 68.04 × 120.96 within TFT 70.78 × 129.17 — cover-glass-to-
  active margins ~4.5 mm sides / ~15 mm top-bottom (room for earpiece + camera band).
- Bond to bezel: 1.0 mm adhesive frame, 0.18 mm thick, 25% compression target;
  screen XY allowance 0.3 mm. Display gap-to-bezel cosmetic target 0.15 ±0.15 mm.
- Stackup z from front 0.35 mm; cover glass 0.70 + TFT 1.70 + 0.30 air/FPC fits the
  front budget.

**Spacing & neighbor interaction:**
- Neighbors: earpiece (12 × 6 × 2.5) and front camera (§2) in the top non-active
  band; bottom mic/speaker below. The ~15 mm top inactive margin must host the
  earpiece slot, top mic tunnel, and front-camera aperture without the active area
  intruding. Recommend keeping front-camera aperture ≥ 1.5 mm clear of the active
  edge to avoid notch encroachment, and earpiece ≥ 1.0 mm from active edge.
- FPC exit + bend: connector 19.0 × 3.2 × 1.15, bend radius 1.0 mm. Verify the FPC
  tail length reaches the mainboard connector with the 1.0 mm bend radius and no
  kink at the -2.1 mm PCB z-center; bend radius 1.0 mm is acceptable for a single
  flex but confirm dynamic vs static bend per vendor.

**Occlusion / collision risk:**
- Low/medium. Main risk is FPC bend-radius violation at assembly (kink → open) and
  active-area encroachment into the earpiece/camera band. Both controlled by the
  screen bond clamp fixture (`screen_bond_clamp_frame`) and the 0.3 mm XY allowance.

**Open issues / blockers:**
- Exact pinout, FPC drawing, init sequence, touch controller selection (freeze
  blockers, BOM line 12). Touch controller MPN is currently unspecified.

---

## Summary verdicts

| Component | Manufacturable | Notes |
|---|---|---|
| Rear camera (OV13B10 AF) | YES (conditional) | sub-4 mm module beats 5.1 mm budget; baffle + battery-swell keepout pending |
| Front camera (GC5035 FF) | YES | clean fit; confirm black-mask aperture |
| Rear torch/flash (LXCL-PWF1 + AW36515) | CONDITIONAL | footprint reconcile + crosstalk isolation gating |
| Screen (Chenghao 5.5" FHD + CTP) | YES (conditional) | needs FPC drawing + touch controller MPN |

**Recommended camera-flash minimum spacing: ≥ 6.0 mm center-to-center (5.0 mm hard
floor), plus a mandatory opaque internal septum and black inter-window mask** —
flush coplanar windows raise crosstalk risk vs a traditional bumped design.

**Top blockers:** (1) flash↔camera stray-light isolation + actual ≥6 mm spacing not
yet dimensioned in params; (2) flash LED footprint (1.64×0.90) vs 1.0×1.0 seat
mismatch; (3) flash LED + driver IC missing from cost BOM; (4) battery pouch-swell
keepout vs the 0.15 mm battery-to-back-wall gap.
