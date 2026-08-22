# @elizaos/plugin-signal

Signal is intentionally unsupported in this revision.

The prior implementation delegated all messaging to `signal-cli`, either by
spawning its daemon or calling a separately installed REST process. That is not
a first-party in-process transport, so its services, routes, configuration,
pairing flow, UI authority, and synthetic success surfaces were removed.

The official [`signalapp/libsignal`](https://github.com/signalapp/libsignal)
project supplies protocol cryptography, not a complete drop-in Signal
messaging client. It is AGPL-3.0 and its Node bridge does not provide the
complete account, storage, service API, group, attachment, and receive-loop
implementation this connector requires. Signal's own issue tracker also leaves
[App Store distribution under that license unresolved](https://github.com/signalapp/libsignal/issues/677).
The previously declared `@elizaos/signal-native` package is not published to
npm. Consequently there is no dependency that can be honestly bundled into
this MIT product as a working direct connector today.

Importing the package remains a deliberate compatibility boundary: plugin
initialization throws `SIGNAL_DIRECT_TRANSPORT_UNAVAILABLE`. It advertises no
connector source, service, action, provider, route, or auto-enable capability.

Re-enabling Signal requires a reviewed, distributable, in-process client that
implements the real Signal service contract and stores credentials through the
canonical elizaOS vault. An HTTP bridge, daemon subprocess, package-manager
installer, or fabricated mock does not satisfy that requirement.
