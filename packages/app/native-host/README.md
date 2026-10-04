# Native consumer host

Explicit Node ESM adapters for applications embedding an Eliza agent. Import via
`@elizaos/app/native-host/<module>`. These modules do not start services on import.

`local-agent-gateway` owns the restricted loopback bridge, credential binding,
conversation ownership, cancellation and authenticated task presentation. Hosts
supply identity, origins, storage, inference availability, reputation and a
`transformMessage` callback for their validated application context. The callback
cannot select upstream routes or override the direct-message channel.

`cloud-runtime-routes` owns CLI-session login, voice, managed Gmail and account
change guards. It accepts explicit HTTPS origins and credential storage; native
hosts should supply their encrypted broker. Its Google read port requires an
explicit grant and validates complete pagination and attachment hashes. The
separate document facade preserves account and cancellation checks around vision.
`document-runtime` requires an explicit reviewed commit and canvas version.

Run `bun run --cwd packages/app test:native-host`. Tests use isolated HTTP peers,
temporary files and synthetic credentials; they do not establish live Cloud,
Google, model, Android or device acceptance.
