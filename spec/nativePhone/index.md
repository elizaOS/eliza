# Native phone

The [Android phone](../os/android/phone.md) and [voicemail](../os/android/voicemail.md) specifications own system dialer effects. The native package exposes a phone surface and checked read/write results.

## Story: Check calls and use the dialer without mistaking a handoff for a call

> As the owner, I want status and complete history to reflect Telecom and provider evidence.

### Opening the dialer and placing a call require different authority

The control asks Android to present the dialer without initiating calls. Calling requires platform Telecom and the current phone permission. Reading the call history requires its own grant. The provider validates history limits at the boundary.

```quint
type PhoneOperation = PhoneStatus | OpenPhoneDialer | PlaceNativeCall | ReadCallHistory
type PhoneAuthority = { supported: bool, dialerAvailable: bool, telecomAvailable: bool, callGrant: bool, historyGrant: bool, owner: bool }
pure def mayUseNativePhone(authority: PhoneAuthority, operation: PhoneOperation): bool =
  operation == PhoneStatus or
  (authority.supported and authority.owner and
   (if (operation == OpenPhoneDialer) authority.dialerAvailable else
    if (operation == PlaceNativeCall) authority.telecomAvailable and authority.callGrant
    else authority.historyGrant))
pure def lawCallNeedsTelecom(authority: PhoneAuthority): bool =
  mayUseNativePhone(authority, PlaceNativeCall) implies authority.telecomAvailable and authority.callGrant
pure val authorityValues = Set(
  { supported: true, dialerAvailable: true, telecomAvailable: true, callGrant: true, historyGrant: true, owner: true },
  { supported: true, dialerAvailable: true, telecomAvailable: false, callGrant: true, historyGrant: true, owner: true },
  { supported: true, dialerAvailable: true, telecomAvailable: true, callGrant: false, historyGrant: true, owner: true })
```
