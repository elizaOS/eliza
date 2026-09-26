# Remote control host

Composes owner-granted browser devices with runtime encrypted secrets and the signed remote-control protocol. The relay never receives private keys or plaintext commands.

Run `bun run --cwd packages/remote-control-host test` and `bun run --cwd packages/remote-control-host typecheck`. App host entry and provisioning tests remain in `packages/app/src/services`.
