# Release inputs

`schema/` contains the JSON contracts consumed by release signing, validation,
and confidential-image checks. The schemas and unsigned candidate manifest were
recovered from elizaOS/os commit `735afc708eb3e7a76050c0c918c916bb5545b0bf`.

`v0.1.0-beta.1/manifest.json` is a candidate inventory with unavailable artifact
URLs and checksums, not a published download list. Release assembly must supply
measured bytes, signatures, and producer evidence before promotion.

`eliza-source.lock.json` pins the application checkout used by standalone release
builders. Embedded development uses the enclosing Eliza workspace. Confidential
measurement fixtures live only in `scripts/__tests__/fixtures`; confidential
check commands require an explicit `--manifest` input.
