# Read-write includes directory

This directory is used to share files between the host and the Tails VM.

When you add `early_patch` (or `patch`) to the boot options of the Tails
VM, any files in this directory will be bind mounted (or copied, if you
use `early_patch=umount`) to the root filesystem of the Tails VM in the
initramfs phase of the boot process.

If the files are bind mounted, they will be read-write in the Tails VM,
so any changes made in the Tails VM will be reflected on the host,
allowing you to persist changes across reboots.

The files and directories in this directory must be writable by the
libvirt-qemu user on the host. Before modifying this directory, please
run the `config/patch/set-rw-includes-permissions.sh` script to set
the correct permissions; it sets a default ACL that are applied to
files and directories when they are created (existing files are
unaffected) so you will not have to think about this again.

Furthermore you need to make sure the `tails.git` filesystem share is
writable by dropping `<readonly/>` from it in your libvirt domain
configuration.

## Examples

Make the bash history persistent for root and amnesia:

```bash
mkdir -p rw-includes/root rw-includes/home/amnesia
touch rw-includes/root/.bash_history rw-includes/home/amnesia/.bash_history
```

Have a `.bashrc` for the root user:

```bash
mkdir -p rw-includes/root
cp /etc/skel/.bashrc rw-includes/root/
```
