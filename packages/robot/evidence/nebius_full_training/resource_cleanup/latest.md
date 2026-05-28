# Nebius Resource Cleanup

Generated: `2026-05-24T09:18:38Z`

Cleaned unused Nebius resources in `project-e00kfz6cpr00q21z892vec`.
The clean training run had already completed with `status/success.txt` at
`2026-05-24T07:20:33Z`; its compute instance and disk were gone by the final
cleanup pass.

| resource | id | action | result |
|---|---|---|---|
| obsolete instance | `computeinstance-e00x4sqmx07qwehxrc` | delete | ok |
| obsolete disk | `computedisk-e00te9qnayns1bsz15` | delete | ok |
| clean-run instance | `computeinstance-e00vp47p03jxxtqev3` | verify absent | ok |
| clean-run disk | `computedisk-e00bef82gpgk1qgx5y` | verify absent | ok |
| training artifact bucket | `storagebucket-e005281935902153032806` | delete + purge | ok |

Final inventory:

| resource type | count |
|---|---:|
| compute instances | 0 |
| compute disks | 0 |
| compute filesystems | 0 |
| storage buckets | 0 |
| mk8s clusters | 0 |

Retained only default VPC resources:

| resource | id |
|---|---|
| network | `vpcnetwork-e00mgn1s4e51aazwmq` |
| subnet | `vpcsubnet-e00ahpd6vbm4m8zk0q` |
