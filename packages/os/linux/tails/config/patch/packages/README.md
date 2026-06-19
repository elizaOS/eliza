# Packages

This directory is used to install additional packages in a Tails VM. If
the `early_patch` boot option is used, .deb files in this directory will
be installed in the Tails VM during the initramfs phase of the boot
process.

To avoid dependency issues, the packages are expected in a subdirectory
named after the major version of the Tails version you are using. So
for Tails 6.0, the packages should be in a directory named `6`.

## Examples

Have vim installed in the Tails VM:

```bash
mkdir -p 6; cd 6
apt download vim/trixie vim-runtime/trixie
```

Have d-feet installed in the Tails VM to easily inspect and use D-Bus
services:

```bash
mkdir -p 6; cd 6
apt download d-feet/trixie
```

Have htop installed in the Tails VM:

```bash
mkdir -p 6; cd 6
apt download htop/trixie
```
