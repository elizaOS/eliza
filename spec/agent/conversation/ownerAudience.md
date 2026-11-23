# Private delivery for owner turns

## Story: Use my private records in my own conversation

> As the owner, I want tools that handle my private records to run only
> when the agent can verify that the reply is addressed to me.

### The agent checks the stored room when an owner turn offers a disclosure-gated tool

The host checks the current message's stored room and membership with
Core's canonical-room attestation. The authenticated launch role and the
admitted action list determine whether the check is needed. A renderer's
screen data, channel label or claimed audience provides no authority.
If attestation cannot be read, ordinary tools and chat can continue.
The disclosure gate still refuses a tool when the audience is absent or
shared, and it rechecks the audience when the tool runs.

```quint
pure def privateAudienceCheckNeeded(ownerRole: bool, offersDisclosureGate: bool): bool =
  ownerRole and offersDisclosureGate
pure def lawAnUnprivilegedTurnDoesNotSeekOwnerAudience(offersDisclosureGate: bool): bool =
  not(privateAudienceCheckNeeded(false, offersDisclosureGate))
pure def lawOrdinaryTurnsNeedNoAudienceRead(ownerRole: bool): bool =
  not(privateAudienceCheckNeeded(ownerRole, false))
pure def lawAProtectedOwnerTurnChecksTheRoom(): bool =
  privateAudienceCheckNeeded(true, true)
```

### The audience lease ends with the turn

Core binds the attestation to the exact message and runtime. The host
opens a lease for Core to renew it during that turn and closes the lease
on every exit, including interruption. The lease uses the active turn's
cancel signal. Replaying a stored reply does not open a new lease.
