# Security subsystem

The e1 chip has no production security boundary. It only reserves the
architectural slot for:
The e1 chip has no security boundary. It only reserves the architectural slot for:

> **Status note:** The current implementation uses placeholder cryptography
> (XOR-based hash, static device key). This is a structural scaffold for
> simulation and architecture validation only. Production derivatives must
> replace these with real cryptographic primitives (SHA-256/ECDSA for image
> authentication, hardware-generated device keys from a TRNG-seeded key
> manager). Do not claim cryptographic secure boot from this repository state.

The checked-in boot ROM is an identity/contract ROM, not a secure boot ROM. It
publishes fixed contract words and a boot-vector placeholder for simulation and
platform-contract checks. It does not authenticate firmware, bind an image to a
device key, enforce rollback protection, measure boot state, or derive secrets.

## Lifecycle states

The first full SoC should implement structural separation before implementing a
rich secure enclave.
The first full SoC should implement structural separation before implementing a rich secure enclave.

## Secure Boot Boundary

Current status is fail-closed scaffold only. The identity/contract ROM is not
production ROM code, does not authenticate firmware, and does not lock debug.
Do not claim secure boot from this repository state.

Required negative evidence includes Unsigned, tampered, wrong-key, corrupt, and
rollback image rejection cases. Debug locked behavior also needs a target
transcript proving debug unlock denied, key erasure, and lifecycle/RMA policy.

Exact gate terms: identity/contract ROM; not production ROM code; Do not claim
secure boot; Unsigned, tampered, wrong-key; rollback image rejection; Debug
locked.
