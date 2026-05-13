# Per-host SSH key for the VM test harness

`usbeliza_dev_ed25519` (private) is generated locally on first
`vm-build-base` and stays gitignored. The matching `.pub` key is committed
so `vm/scripts/build-base.sh` can install it into the qcow2's
`/home/eliza/.ssh/authorized_keys` for the `eliza` user.

The private key is **only useful inside the dev VM** — there's no port
forward to the public internet, the VM listens on `127.0.0.1` only, and
the eliza user has NOPASSWD sudo. If the private key leaks, the worst
case is someone with shell access to your laptop can SSH into a VM you
have running, which they could already do anyway.

## Regenerate

If you need a fresh keypair:

```sh
rm -f vm/.ssh/usbeliza_dev_ed25519 vm/.ssh/usbeliza_dev_ed25519.pub
just vm-build-base
```

`build-base.sh` regenerates the private/public pair automatically when
the private file is missing, then bakes the new public half into the
qcow2.
