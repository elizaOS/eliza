# Linux image builders

The default builder produces the persistent [mkosi GNOME image](mkosi/README.md):

```bash
make -C packages/os/linux/elizaos build ARCH=amd64 PROFILE=gui
make -C packages/os/linux/elizaos lint
```
