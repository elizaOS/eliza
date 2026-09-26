# Linux image builders

The default builder produces the persistent [mkosi GNOME image](mkosi/README.md):

```bash
make -C packages/os/linux/elizaos build ARCH=amd64 PROFILE=gui
make -C packages/os/linux/elizaos lint
```

`build-live-iso.sh`, `config/`, and `auto/` retain the older ISO pipeline. Use
`make legacy-iso` and `make legacy-lint` from this directory for those paths.
