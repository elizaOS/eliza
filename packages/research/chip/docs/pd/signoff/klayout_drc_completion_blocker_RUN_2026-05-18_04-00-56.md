# OpenLane Run Diagnosis: RUN_2026-05-18_04-00-56

- generated_at: 2026-05-18T23:12:35.690465+00:00
- run_dir: `pd/openlane/runs/RUN_2026-05-18_04-00-56`
- status: blocked
- blocker_step: `64-klayout-drc`
- blocker: step directory exists without `state_out.json`
- last_discovered_step: `64-klayout-drc`
- last_completed_step: `63-magic-drc`

## Blocking Step Evidence
- `state_in.json`: 22256 bytes
- `state_out.json`: missing
- `runtime.txt`: missing
- `COMMANDS`: 412 bytes
- `config.json`: 6470 bytes
- `klayout-drc.process_stats.json`: 496 bytes
  - runtime: {'cpu_time_user': '00:08:04.990', 'cpu_time_system': '00:00:02.700', 'runtime': '00:07:57.518', 'cpu_time_iowait': '00:00:00.000'}
  - peak_resources: {'cpu_percent': 410.0, 'memory_rss': '6GiB', 'memory_vms': '7GiB', 'threads': 9}
- `klayout-drc.log`: 47140 bytes
- reports: directory exists but contains no report files

## Command
```text
klayout -b -zz -r /work/external/pdks/sky130A/libs.tech/klayout/drc/sky130A_mr.drc -rd input=/work/pd/openlane/runs/RUN_2026-05-18_04-00-56/57-magic-streamout/e1_chip_top.gds -rd topcell=e1_chip_top -rd report=/work/pd/openlane/runs/RUN_2026-05-18_04-00-56/64-klayout-drc/reports/drc_violations.klayout.xml -rd feol=true -rd beol=true -rd floating_metal=false -rd offgrid=true -rd seal=true -rd threads=16
```

## Tail: klayout-drc.log
```text
"space" in: sky130A_mr.drc:504
    Edge pairs: 0 (flat)  0 (hierarchical)
    Elapsed: 32.010s  Memory: 3142.00M
"output" in: sky130A_mr.drc:504
    Edge pairs: 0 (flat)  0 (hierarchical)
    Elapsed: 0.050s  Memory: 3142.00M
"-" in: sky130A_mr.drc:505
    Polygons (raw): 5512711 (flat)  7769 (hierarchical)
    Elapsed: 0.040s  Memory: 3142.00M
"enclosing" in: sky130A_mr.drc:506
    Edge pairs: 4859324 (flat)  4291751 (hierarchical)
    Elapsed: 135.470s  Memory: 4020.00M
"second_edges" in: sky130A_mr.drc:506
    Edges: 4859324 (flat)  4291751 (hierarchical)
    Elapsed: 0.120s  Memory: 4101.00M
"width" in: sky130A_mr.drc:507
    Edge pairs: 0 (flat)  0 (hierarchical)
    Elapsed: 7.920s  Memory: 5071.00M
"polygons" in: sky130A_mr.drc:508
    Polygons (raw): 0 (flat)  0 (hierarchical)
    Elapsed: 0.020s  Memory: 4923.00M
"interacting" in: sky130A_mr.drc:508
    Polygons (raw): 0 (flat)  0 (hierarchical)
    Elapsed: 0.040s  Memory: 4923.00M
"output" in: sky130A_mr.drc:509
    Polygons (raw): 0 (flat)  0 (hierarchical)
    Elapsed: 0.040s  Memory: 4923.00M
"interacting" in: sky130A_mr.drc:510
    Polygons (raw): 0 (flat)  0 (hierarchical)
    Elapsed: 0.040s  Memory: 4923.00M
"-" in: sky130A_mr.drc:510
    Polygons (raw): 4505807 (flat)  201916 (hierarchical)
    Elapsed: 0.040s  Memory: 4923.00M
"with_area" in: sky130A_mr.drc:511
    Polygons (raw): 0 (flat)  0 (hierarchical)
    Elapsed: 19.170s  Memory: 4955.00M
"output" in: sky130A_mr.drc:511
    Polygons (raw): 0 (flat)  0 (hierarchical)
    Elapsed: 0.050s  Memory: 4955.00M
"&" in: sky130A_mr.drc:512
    Polygons (raw): 0 (flat)  0 (hierarchical)
    Elapsed: 0.040s  Memory: 4955.00M
"space" in: sky130A_mr.drc:513
    Edge pairs: 0 (flat)  0 (hierarchical)
    Elapsed: 0.040s  Memory: 4955.00M
"output" in: sky130A_mr.drc:513
    Edge pairs: 0 (flat)  0 (hierarchical)
    Elapsed: 0.040s  Memory: 4955.00M
"width" in: sky130A_mr.drc:514
    Edge pairs: 0 (flat)  0 (hierarchical)
    Elapsed: 0.030s  Memory: 4955.00M
"output" in: sky130A_mr.drc:514
    Edge pairs: 0 (flat)  0 (hierarchical)
    Elapsed: 0.040s  Memory: 4955.00M
END: 67/20 (li)
START: 67/44 (mcon)
"-" in: sky130A_mr.drc:519
    Polygons (raw): 13480299 (flat)  203230 (hierarchical)
    Elapsed: 0.040s  Memory: 4955.00M
"drc" in: sky130A_mr.drc:521
```

## KLayout DRC Interpretation
- The KLayout DRC subprocess started and emitted rule-progress logs, but did not write the expected DRC report XML or OpenLane `state_out.json`.
- Treat this as an interrupted/incomplete signoff step, not as clean DRC.
- Likely local causes to verify are wall-clock timeout, host/container kill, or memory pressure during the BEOL/mcon rules.

## Release Status
- Do not use this run as tapeout/signoff evidence until `final/` exists and release checks pass.
