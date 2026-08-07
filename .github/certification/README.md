# Certification trust anchor

`certification-public-key.pem` is the Ed25519 public key used by the evidence
package's signing and verification tools. Its trusted fingerprint is
`3ac9e3e625a9ed2f` (the first 16 hexadecimal characters of the SHA-256 digest
of the SPKI DER).

The repository no longer runs a dedicated certification workflow. Evidence
certification is an operator-run release/review activity:

```bash
bun run --cwd packages/evidence certify:verify -- \
  --cert <path/to/certification.json> \
  --bundle <bundle-dir> \
  --pubkey .github/certification/certification-public-key.pem \
  --expected-commit <commit> \
  --required-tier full \
  --json
```

The private key must never be committed. To rotate trust, generate a new key,
replace the PEM and fingerprint in the same reviewed change, then update the
operator-held private key.
