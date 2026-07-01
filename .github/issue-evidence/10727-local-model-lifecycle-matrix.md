# Local Model Lifecycle Matrix (#10727)

Observed: 2026-07-01T17:27:34.068Z
Host: darwin-arm64, RAM 128 GB, GPU metal, expected backend metal

## Summary

- Rows: 37
- Failing rows: 30
- Rows with unknown evidence: 37
- Installed rows: 0
- On-device verified rows: 0
- Pending publish rows: 21

## Matrix

| Model | Component | Publish | Download | Installed | Load/run | Backend | Blockers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| eliza-1-2b | text | pass: tier publish status is published | pass: HTTP 200 OK | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | none |
| eliza-1-2b | voice | pass: tier publish status is published | fail: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | downloadable: HTTP 404 Not Found |
| eliza-1-2b | asr | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | implemented: asr is expected but has no catalog source file; deployable: asr is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact |
| eliza-1-2b | vad | pass: tier publish status is published | pass: HTTP 200 OK | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | none |
| eliza-1-2b | embedding | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | implemented: embedding is expected but has no catalog source file; deployable: embedding is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact |
| eliza-1-2b | vision | pass: tier publish status is published | pass: HTTP 200 OK | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | none |
| eliza-1-2b | litert | pass: tier publish status is published | fail: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | downloadable: HTTP 404 Not Found |
| eliza-1-2b | mtp | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | implemented: mtp is expected but has no catalog source file; deployable: mtp is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact |
| eliza-1-4b | text | pass: tier publish status is published | pass: HTTP 200 OK | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | none |
| eliza-1-4b | voice | pass: tier publish status is published | fail: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | downloadable: HTTP 404 Not Found |
| eliza-1-4b | asr | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | implemented: asr is expected but has no catalog source file; deployable: asr is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact |
| eliza-1-4b | vad | pass: tier publish status is published | pass: HTTP 200 OK | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | none |
| eliza-1-4b | embedding | pass: tier publish status is published | pass: HTTP 200 OK | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | none |
| eliza-1-4b | vision | pass: tier publish status is published | pass: HTTP 200 OK | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | none |
| eliza-1-4b | litert | pass: tier publish status is published | fail: HTTP 404 Not Found | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | downloadable: HTTP 404 Not Found |
| eliza-1-4b | mtp | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | implemented: mtp is expected but has no catalog source file; deployable: mtp is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact |
| eliza-1-9b | text | fail: tier publish status is pending | fail: tier publish status is pending | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | published: tier publish status is pending; downloadable: tier publish status is pending |
| eliza-1-9b | voice | fail: tier publish status is pending | fail: tier publish status is pending | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | published: tier publish status is pending; downloadable: tier publish status is pending |
| eliza-1-9b | asr | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | implemented: asr is expected but has no catalog source file; deployable: asr is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact |
| eliza-1-9b | vad | fail: tier publish status is pending | fail: tier publish status is pending | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | published: tier publish status is pending; downloadable: tier publish status is pending |
| eliza-1-9b | embedding | fail: tier publish status is pending | fail: tier publish status is pending | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | published: tier publish status is pending; downloadable: tier publish status is pending |
| eliza-1-9b | vision | fail: tier publish status is pending | fail: tier publish status is pending | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | published: tier publish status is pending; downloadable: tier publish status is pending |
| eliza-1-9b | mtp | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | implemented: mtp is expected but has no catalog source file; deployable: mtp is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact |
| eliza-1-27b | text | fail: tier publish status is pending | fail: tier publish status is pending | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | published: tier publish status is pending; downloadable: tier publish status is pending |
| eliza-1-27b | voice | fail: tier publish status is pending | fail: tier publish status is pending | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | published: tier publish status is pending; downloadable: tier publish status is pending |
| eliza-1-27b | asr | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | implemented: asr is expected but has no catalog source file; deployable: asr is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact |
| eliza-1-27b | vad | fail: tier publish status is pending | fail: tier publish status is pending | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | published: tier publish status is pending; downloadable: tier publish status is pending |
| eliza-1-27b | embedding | fail: tier publish status is pending | fail: tier publish status is pending | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | published: tier publish status is pending; downloadable: tier publish status is pending |
| eliza-1-27b | vision | fail: tier publish status is pending | fail: tier publish status is pending | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | published: tier publish status is pending; downloadable: tier publish status is pending |
| eliza-1-27b | mtp | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | implemented: mtp is expected but has no catalog source file; deployable: mtp is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact |
| eliza-1-27b-256k | text | fail: tier publish status is pending | fail: tier publish status is pending | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | published: tier publish status is pending; downloadable: tier publish status is pending |
| eliza-1-27b-256k | voice | fail: tier publish status is pending | fail: tier publish status is pending | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | published: tier publish status is pending; downloadable: tier publish status is pending |
| eliza-1-27b-256k | asr | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | implemented: asr is expected but has no catalog source file; deployable: asr is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact |
| eliza-1-27b-256k | vad | fail: tier publish status is pending | fail: tier publish status is pending | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | published: tier publish status is pending; downloadable: tier publish status is pending |
| eliza-1-27b-256k | embedding | fail: tier publish status is pending | fail: tier publish status is pending | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | published: tier publish status is pending; downloadable: tier publish status is pending |
| eliza-1-27b-256k | vision | fail: tier publish status is pending | fail: tier publish status is pending | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | published: tier publish status is pending; downloadable: tier publish status is pending |
| eliza-1-27b-256k | mtp | fail: catalog does not advertise a hosted artifact for this component | fail: no download URL exists for this artifact | unknown: bundle is not installed in this state dir | skipped: no installed bundle on this host, so load/run evidence is absent | metal | implemented: mtp is expected but has no catalog source file; deployable: mtp is expected but has no catalog source file; published: catalog does not advertise a hosted artifact for this component; downloadable: no download URL exists for this artifact |

## Blockers

- eliza-1-2b:voice: downloadable: HTTP 404 Not Found
- eliza-1-2b:asr: implemented: asr is expected but has no catalog source file
- eliza-1-2b:asr: deployable: asr is expected but has no catalog source file
- eliza-1-2b:asr: published: catalog does not advertise a hosted artifact for this component
- eliza-1-2b:asr: downloadable: no download URL exists for this artifact
- eliza-1-2b:embedding: implemented: embedding is expected but has no catalog source file
- eliza-1-2b:embedding: deployable: embedding is expected but has no catalog source file
- eliza-1-2b:embedding: published: catalog does not advertise a hosted artifact for this component
- eliza-1-2b:embedding: downloadable: no download URL exists for this artifact
- eliza-1-2b:litert: downloadable: HTTP 404 Not Found
- eliza-1-2b:mtp: implemented: mtp is expected but has no catalog source file
- eliza-1-2b:mtp: deployable: mtp is expected but has no catalog source file
- eliza-1-2b:mtp: published: catalog does not advertise a hosted artifact for this component
- eliza-1-2b:mtp: downloadable: no download URL exists for this artifact
- eliza-1-4b:voice: downloadable: HTTP 404 Not Found
- eliza-1-4b:asr: implemented: asr is expected but has no catalog source file
- eliza-1-4b:asr: deployable: asr is expected but has no catalog source file
- eliza-1-4b:asr: published: catalog does not advertise a hosted artifact for this component
- eliza-1-4b:asr: downloadable: no download URL exists for this artifact
- eliza-1-4b:litert: downloadable: HTTP 404 Not Found
- eliza-1-4b:mtp: implemented: mtp is expected but has no catalog source file
- eliza-1-4b:mtp: deployable: mtp is expected but has no catalog source file
- eliza-1-4b:mtp: published: catalog does not advertise a hosted artifact for this component
- eliza-1-4b:mtp: downloadable: no download URL exists for this artifact
- eliza-1-9b:text: published: tier publish status is pending
- eliza-1-9b:text: downloadable: tier publish status is pending
- eliza-1-9b:voice: published: tier publish status is pending
- eliza-1-9b:voice: downloadable: tier publish status is pending
- eliza-1-9b:asr: implemented: asr is expected but has no catalog source file
- eliza-1-9b:asr: deployable: asr is expected but has no catalog source file
- eliza-1-9b:asr: published: catalog does not advertise a hosted artifact for this component
- eliza-1-9b:asr: downloadable: no download URL exists for this artifact
- eliza-1-9b:vad: published: tier publish status is pending
- eliza-1-9b:vad: downloadable: tier publish status is pending
- eliza-1-9b:embedding: published: tier publish status is pending
- eliza-1-9b:embedding: downloadable: tier publish status is pending
- eliza-1-9b:vision: published: tier publish status is pending
- eliza-1-9b:vision: downloadable: tier publish status is pending
- eliza-1-9b:mtp: implemented: mtp is expected but has no catalog source file
- eliza-1-9b:mtp: deployable: mtp is expected but has no catalog source file
- eliza-1-9b:mtp: published: catalog does not advertise a hosted artifact for this component
- eliza-1-9b:mtp: downloadable: no download URL exists for this artifact
- eliza-1-27b:text: published: tier publish status is pending
- eliza-1-27b:text: downloadable: tier publish status is pending
- eliza-1-27b:voice: published: tier publish status is pending
- eliza-1-27b:voice: downloadable: tier publish status is pending
- eliza-1-27b:asr: implemented: asr is expected but has no catalog source file
- eliza-1-27b:asr: deployable: asr is expected but has no catalog source file
- eliza-1-27b:asr: published: catalog does not advertise a hosted artifact for this component
- eliza-1-27b:asr: downloadable: no download URL exists for this artifact
- eliza-1-27b:vad: published: tier publish status is pending
- eliza-1-27b:vad: downloadable: tier publish status is pending
- eliza-1-27b:embedding: published: tier publish status is pending
- eliza-1-27b:embedding: downloadable: tier publish status is pending
- eliza-1-27b:vision: published: tier publish status is pending
- eliza-1-27b:vision: downloadable: tier publish status is pending
- eliza-1-27b:mtp: implemented: mtp is expected but has no catalog source file
- eliza-1-27b:mtp: deployable: mtp is expected but has no catalog source file
- eliza-1-27b:mtp: published: catalog does not advertise a hosted artifact for this component
- eliza-1-27b:mtp: downloadable: no download URL exists for this artifact
- eliza-1-27b-256k:text: published: tier publish status is pending
- eliza-1-27b-256k:text: downloadable: tier publish status is pending
- eliza-1-27b-256k:voice: published: tier publish status is pending
- eliza-1-27b-256k:voice: downloadable: tier publish status is pending
- eliza-1-27b-256k:asr: implemented: asr is expected but has no catalog source file
- eliza-1-27b-256k:asr: deployable: asr is expected but has no catalog source file
- eliza-1-27b-256k:asr: published: catalog does not advertise a hosted artifact for this component
- eliza-1-27b-256k:asr: downloadable: no download URL exists for this artifact
- eliza-1-27b-256k:vad: published: tier publish status is pending
- eliza-1-27b-256k:vad: downloadable: tier publish status is pending
- eliza-1-27b-256k:embedding: published: tier publish status is pending
- eliza-1-27b-256k:embedding: downloadable: tier publish status is pending
- eliza-1-27b-256k:vision: published: tier publish status is pending
- eliza-1-27b-256k:vision: downloadable: tier publish status is pending
- eliza-1-27b-256k:mtp: implemented: mtp is expected but has no catalog source file
- eliza-1-27b-256k:mtp: deployable: mtp is expected but has no catalog source file
- eliza-1-27b-256k:mtp: published: catalog does not advertise a hosted artifact for this component
- eliza-1-27b-256k:mtp: downloadable: no download URL exists for this artifact
