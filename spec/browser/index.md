# Browser

The browser package (`packages/browser`) lets the agent open, read and act
in a browser on the person's behalf: the browser surface mounted on the
device, an owned browser beside it, or a browser on a device the owner
paired with a hosted agent. Every command is bound to the page and grant it
was admitted for, and no unverified outcome is reported as success. The
device's own browser surface, storage and reading are specified under
[os browser](../os/index.md).

| Area | Specifications |
| --- | --- |
| Requests | [Request grounding](./requestGrounding.md), [remote control](./remoteControl.md), [arbitration](./arbitration.md) |
| Guided websites | [Model inference](./inference.md), [manual activity](./manualActivity.md), [payment controls](./paymentControl.md) |
| Credentials | [Clipboard lease](./clipboardLease.md) |
