# elizaOS apt Repository

Add the elizaOS apt repository to get automatic updates:

```bash
curl -fsSL https://apt.elizaos.ai/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/elizaos.gpg
echo "deb [signed-by=/usr/share/keyrings/elizaos.gpg] https://apt.elizaos.ai stable main" | \
  sudo tee /etc/apt/sources.list.d/elizaos.list
sudo apt update && sudo apt install elizaos-app
```

## CI secrets required

- `DEBIAN_GPG_PRIVATE_KEY` — armored GPG private key (`gpg --armor --export-secret-keys <key-id>`)
- `DEBIAN_GPG_KEY_ID` — 16-char key ID
- `DEBIAN_GPG_PASSPHRASE` — passphrase (if the key has one)

The repo is hosted via GitHub Pages on the `apt-repo` branch.
