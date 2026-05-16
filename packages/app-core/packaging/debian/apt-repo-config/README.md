# elizaOS apt Repository

Users install elizaOS App via apt:

```bash
curl -fsSL https://apt.elizaos.ai/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/elizaos.gpg
echo "deb [signed-by=/usr/share/keyrings/elizaos.gpg] https://apt.elizaos.ai stable main" | sudo tee /etc/apt/sources.list.d/elizaos.list
sudo apt update && sudo apt install elizaos-app
```

## Repository structure

The apt repo is hosted at `https://apt.elizaos.ai/` (served from the `apt-repo` GitHub Pages branch).

Managed with `reprepro`. Config lives in this directory.

## Secrets required for CI publishing

- `DEBIAN_GPG_PRIVATE_KEY`: armored GPG private key for signing (export with `gpg --armor --export-secret-keys <key-id>`)
- `DEBIAN_GPG_KEY_ID`: the 16-char key ID
- `DEBIAN_GPG_PASSPHRASE`: passphrase if the key has one
