# elizaOS apt Repository

The repository currently publishes the amd64 package built and boot-tested by
the release workflow. It does not advertise an ARM index for an unavailable
artifact.

Add the elizaOS apt repository to get automatic updates:

```bash
curl -fsSL https://apt.elizaos.ai/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/elizaos.gpg
echo "deb [signed-by=/usr/share/keyrings/elizaos.gpg] https://apt.elizaos.ai stable main" | \
  sudo tee /etc/apt/sources.list.d/elizaos.list
sudo apt update && sudo apt install elizaos-app
```

## CI secrets required

- `DEBIAN_GPG_PRIVATE_KEY` — armored GPG private key (`gpg --armor --export-secret-keys <fingerprint>`)
- `DEBIAN_GPG_KEY_ID` — exact 40-hex primary-key fingerprint from `gpg --with-colons --fingerprint`
- `DEBIAN_GPG_PASSPHRASE` — passphrase (if the key has one)

The publisher imports the key into a unique, empty GPG home and rejects an
archive containing any other primary key. Before `reprepro` runs, every
checked-in `SignWith: default` template is replaced with the verified
fingerprint; no ambiguous default signer reaches the generated repository.
An unconditional loopback signing probe validates the optional passphrase and
unlocks the isolated agent before `reprepro`; the publisher never relies on
`reprepro --ask-passphrase`. Byte-identical retries still re-export repository
metadata for every configured distribution so signing-key or configuration
rotation refreshes both stable and beta signatures before `gpg.key` changes.
The sole automated writer commits to this repository's serialized `apt-repo`
branch after `release-orchestrator.yml` invokes `publish-packages.yml`; neither
tag-triggered `release-all.yml` nor release-created OS workflows publish a
second package. No external repository dispatch participates. GitHub Pages and
DNS are separate owner-managed boundaries. `apt.elizaos.ai` currently has no
DNS record, so a branch update must not be reported as a publicly reachable
apt publication until Pages, DNS ownership, and the HTTPS indexes are verified.
