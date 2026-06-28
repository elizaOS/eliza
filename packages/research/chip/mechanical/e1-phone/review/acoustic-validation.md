# E1 Phone Acoustic Validation

Status: CAD acoustic validation ready; lab measurements still required.

## CAD Acoustic Cases

- PASS: `bottom_speaker_open_area` target >=5 slots and >=0.035 open-area ratio against 1115 speaker face
- PASS: `bottom_speaker_rear_chamber` target >=0.40 cm3 rear chamber for compact 1115 module EVT target
- PASS: `bottom_microphone_porting` target >=2 ports, >=1.0 mm2 total port area, >=1.0 mm USB load-path separation
- PASS: `acoustic_mesh_membranes` target hydrophobic mesh/membrane modeled for speaker, bottom mics, top mic, and handset slot
- PASS: `usb_speaker_isolation` target >=1.0 mm speaker-to-USB mechanical isolation
- PASS: `earpiece_under_glass_path` target >=10 mm2 slot area, 0.4-0.8 mm gasket, front camera clearance passing
- PASS: `interface_acoustic_cases_pass` target bottom audio and handset interface validation pass

## Lab Measurements

- `bottom_speaker_spl_1khz_db` dB SPL fixture `anechoic_box_or_phone_acoustic_jig`
- `bottom_speaker_impedance_ohm` ohm fixture `impedance_sweep`
- `bottom_speaker_leak_delta_db` dB fixture `evt_fixture_bottom_acoustic_leak_mask`
- `bottom_mic_snr_db` dB fixture `calibrated_speech_noise_box`
- `top_mic_snr_db` dB fixture `calibrated_speech_noise_box`
- `earpiece_spl_1khz_db` dB SPL fixture `ear_simulator`
- `earpiece_leak_delta_db` dB fixture `evt_fixture_earpiece_leak_mask`

## Release Blockers

- Need speaker SPL/impedance sweep with molded rear chamber and grille.
- Need microphone SNR/sensitivity data through molded ports, mesh, and gasket stack.
- Need earpiece SPL/leak test through behind-glass slot and compressed gasket.
- Need dust/water ingress review for speaker, microphone, and handset openings.
