# End-to-End Full Training Launch Bundle

Run `scripts/00_local_preflight.sh` before copying this repo to Nebius. Scripts run from `ELIZA_ROBOT_PACKAGE_ROOT` when it is set, otherwise from the package root that generated this bundle. On the Nebius host, run `scripts/run_all_nebius_stages.sh`. The generated `preflight_report.json` must have `ok: true` before launch. `nebius_instance_launch_template.json` is the reviewable cloud-init contract; inject Object Storage credentials outside VM metadata and set `NEBIUS_TRAINING_S3_URI` through the runtime secret environment.
