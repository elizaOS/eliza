# Interactive terminals

Session lifecycle, access gates, spawn policy, capacity, and output bounds are specified in [Session store, access and spawn policy](./policy.md).

Every interactive terminal is a session of that store. The operator who passes the route gate, or the owner from chat, drives it; a client identifier sent by the caller is never ownership. Each spawned process gets a new session id with its own scrollback, so output from an earlier process never appears in a later session.
