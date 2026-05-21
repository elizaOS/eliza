# E1 Phone Button + Aperture Orientation Validation

Status: PASS.
Date: 2026-05-20. Reviewer: `automated_orientation_check`.

## Feature outward normals

| Part | Kind | Expected | Measured | Side expected | Side measured | Status |
|------|------|----------|----------|---------------|---------------|--------|
| `power_button_cap` | button | +X | +X | None | +Y | PASS |
| `volume_button_cap` | button | -X | -X | None | +Y | PASS |
| `usb_c_external_aperture` | aperture | -Y | -Y | None | -Y | PASS |
| `earpiece_receiver` | earpiece | +Z | +Z | +Y | +Y | PASS |
| `handset_acoustic_slot` | earpiece_slot | +Z | +Z | +Y | +Y | PASS |
| `bottom_microphone_port_1` | mic_port | -Y | -Y | None | -Y | PASS |
| `bottom_microphone_port_2` | mic_port | -Y | -Y | None | -Y | PASS |
| `top_microphone_port` | mic_port | +Y | +Y | None | +Y | PASS |
| `bottom_speaker_grille_slot_1` | speaker_grille | -Y | -Y | None | -Y | PASS |
| `bottom_speaker_grille_slot_3` | speaker_grille | -Y | -Y | None | -Y | PASS |
| `rear_camera_lens_window` | camera_lens | -Z | -Z | None | +Y | PASS |
| `rear_camera_module` | camera_module | -Z | -Z | None | +Y | PASS |
| `front_camera_under_glass` | front_camera | +Z | +Z | +Y | +Y | PASS |
| `front_camera_module` | front_camera_module | +Z | +Z | +Y | +Y | PASS |

## Switch / cap coaxiality

| Cap | Switch | Press axis | dy (mm) | dz (mm) | Tol (mm) | Status |
|-----|--------|------------|---------|---------|----------|--------|
| `power_button_cap` | `power_button_elastomer_gasket` | X | 0.0 | 0.0 | 0.5 | PASS |
| `volume_button_cap` | `volume_button_elastomer_gasket` | X | 0.0 | 0.0 | 0.5 | PASS |
