# @elizaos/capacitor-passwords

On-device password manager for Eliza Android hosts:

- **Vault** – entries (name, username, password, one or more bindings) in the
  `plugin-native-secure-store` `PasswordVaultStore`: one AES-256-GCM frame in the host's
  no-backup directory, keyed by a non-exportable Android Keystore key that requires user
  authentication (`KeyPolicy`: strong biometric or device credential, host-chosen window,
  default 60 s) and an unlocked device. Because the device credential is always accepted, the
  key is bound to the lock-screen secure ID: enrolling a new biometric does not invalidate it
  (whoever can enroll already knows the credential), while removing the screen lock does. A
  vault whose key is lost or invalidated can only be deleted (`reset`) after a fresh unlock.
  `PasswordVaultAccess#destroyVault` is the host's native way to destroy a readable vault
  ([Host-native vault access](#host-native-vault-access)).
- **Autofill provider** – `ElizaPasswordAutofillService` supports native app fields through Android Autofill, with save capture. Browser
  fields require explicit native per-field origins; ordinary WebView metadata is refused.
- **Vault client** – a Capacitor plugin (`ElizaPasswords`) and a validating TypeScript client for
  the host's own vault UI. Responses are metadata only.

Build from the repository root:

```bash
bun run --cwd plugins/plugin-native-passwords build
bun run --cwd plugins/plugin-native-passwords test   # TS client + JVM policy tests (needs a JDK)
```

## Host integration (Android)

1. Include this module and secure-store's `android-nativeonly` module, which holds the vault
   custody classes without the `SecureStorePlugin` bridge. This module depends on
   `project(':elizaos-capacitor-secure-store-nativeonly')`; set the Gradle property
   `elizaPasswordsSecureStoreProject` if the host names it differently. CSV transfer is in the
   optional `android-transfer` module (`:elizaos-capacitor-passwords-transfer`, which depends on
   `:elizaos-capacitor-passwords`); a host without it has no transfer classes.
2. Register `PasswordsPlugin` in the bridge Activity.
3. Opt in to being an Autofill provider by declaring the service in the host manifest:

   ```xml
   <service android:name="ai.eliza.plugins.passwords.ElizaPasswordAutofillService"
       android:label="@string/eliza_passwords_service_label"
       android:exported="true"
       android:permission="android.permission.BIND_AUTOFILL_SERVICE">
     <intent-filter><action android:name="android.service.autofill.AutofillService" /></intent-filter>
     <meta-data android:name="android.autofill" android:resource="@xml/eliza_passwords_autofill_service" />
   </service>
   ```

4. Override the `eliza_passwords_*` resources (`res/values/eliza_passwords.xml`) with the host's
   vault directory, Keystore alias, AAD, unlock window and browser trust. Preserve deployed
   values when upgrading: changing the alias, AAD or directory makes the old vault unreadable,
   and the store refuses to reuse an alias under a different authentication policy.
5. Keep backup disabled or exclude the no-backup directory (it is excluded by Android).
6. A host that is itself a browser sets `eliza_passwords_host_is_browser` and adds
   `PasswordFormPolicy.TOP_ORIGIN_EXTRA` (the committed top-level HTTPS origin) to its content
   WebView's autofill node in `onProvideAutofillVirtualStructure`. Every login field must
   also carry `PasswordAutofillPolicy.FIELD_ORIGIN` from the native browser engine.
   Never copy the top-level origin onto fields or obtain this authority from page JavaScript.
   Standard WebView does not expose this contract and is not supported for browser Autofill.

The user enables the provider in Android's own confirmation, opened by
`openAutofillSettings()` (`Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE`). `status()` reads back
the selected service; the plugin never sets secure settings or infers selection.

## Fill and save rules

- A fill request never reads the vault. It returns one authentication-gated dataset with no
  values; `PasswordFillActivity` (FLAG_SECURE) always asks for a fresh unlock (an earlier
  unlock is never reused), lists only entries bound to the exact request subject and fills the
  chosen one. Every fill needs that authentication and an explicit choice.
- Subjects come from the framework: the requesting package from `AssistStructure`, and web
  domains only from a trusted browser (the host when it is a browser, or an allowlisted package
  whose signing certificate is verified). Any second web domain in the structure (a cross-origin
  frame), a non-HTTPS scheme, mixed native/web login fields, or a host top-level origin that
  differs from the field origin refuses the request. The host's own native UI is never filled.
- Web bindings match exact origins (`https://host[:port]`); subdomains and ports are distinct.
  Every login field must supply the existing native `PasswordAutofillPolicy.FIELD_ORIGIN`
  metadata and match the admitted origin. Form-level domains alone are insufficient.
  A host browser also supplies its committed top-level origin; other trusted adapters are
  limited to the default-port origin. Missing field origins refuse both Save and Fill.
  App bindings (`android://<sha256>@<package>`) require `PackageManager#hasSigningCertificate`
  to confirm the stored signer, which honours key rotation.
- Password fields need an explicit signal (autofill hint, HTML `type=password`, or a password
  input type); page text, labels and ids are never used for the password field.
- Save requests keep captured values in memory behind a one-shot token. `PasswordSaveActivity`
  asks "Save password?"; nothing is written until the user chooses Save and unlocks. App
  bindings record the app's current signer at capture time.

## Secrets boundary

`openEditor()` creates an entry through a native FLAG_SECURE form, and
`openEditor({entryId, expectedRevision})` edits one. It accepts no draft fields: typing and
generation stay in native memory, and the only result is `{status: "saved", id, revision}` or
`{status: "cancelled"}`. The existing vault unlock must still be active. The editor refuses
overlapping editors, rejects obscured input, disables view-state persistence, autofill and
password copy/cut actions, and clears drafts on Cancel, background, lock or grant expiry. Oversize
edits are rejected as a whole with a visible error, never truncated.

- **Edit.** The form shows the name, username and first web binding, never the stored password.
  An empty password field keeps it, so a metadata edit cannot replace the secret. Other bindings,
  including app bindings, stay and are listed.
- **Revisions.** `list()` reports each entry's `revision`, and every vault write changes it. A
  record that changed since `expectedRevision` rejects with `conflict` before the form opens. If it
  changes while the form is open, Save writes nothing and offers Reload, which shows the latest
  record and discards the draft. Plaintext `save` and `remove` still do not compare revisions.
- **Same sign-in.** The form accepts one exact HTTPS origin. If another entry has the same
  username on that binding, it asks **Update existing** (creating: replaces only that entry's
  password, at the revision it read) or **Keep separate**. It never merges or overwrites silently.

Device-unlocked custody migration is separate work; this method does not change the vault
authentication policy. Hosts stop capture and speech while a secret surface is up
(`PasswordSurfaces`, see [Host-native vault access](#host-native-vault-access)).

No `ElizaPasswords` method resolves with a secret. `save` accepts a password typed by the user
(write-only) or generates one natively (`generate`). A host that sets
`eliza_passwords_bridge_accepts_secrets` to `false` keeps passwords out of the bridge: `save` then
rejects `password`, `generate` and a missing `id` with `invalid`, so a password reaches the vault
only through `openEditor` or Android's save confirmation. `reveal` shows a FLAG_SECURE native dialog
that hides after 30 s or when the host stops; `copy` marks the clip sensitive and schedules
clearing after 45 s. If Android hides clipboard ownership, clearing waits until the host
resumes. A replaced or unidentifiable clip is never deleted. Hosts must describe this as
best-effort expiry, not guaranteed background deletion. `createPasswordsClient` rebuilds every response from
allowlisted fields and rejects any response containing a secret-like key, and errors never echo
inputs. Hosts must keep agent-facing context free of vault data; at most labels and origins.
Queued work is bound to the grant that admitted it; a later unlock cannot revive it.
Destroyed Activities cancel their pending prompts, and old owners cannot revoke a newer grant.
Opening the fill picker preserves the original request deadline. Framework cancellation or a
replacement request revokes the picker before it can publish a result.
The vault locks when the host Activity stops and when the unlock window ends. Hosts that include `android-transfer` can register `PasswordTransferPlugin` (`ElizaPasswordTransfer`) for
CSV export and import. Use `createTransferClient` for count-only results. Export requires
an explicit plaintext-file warning, a user-picked document and fresh authentication after
the picker returns. Export reads one native vault snapshot and writes bounded CSV rows.
Import shows every exact HTTPS origin before one atomic vault update;
existing origin/username pairs are never overwritten. The native parser rejects malformed
CSV and limits imports to 2 MB and 1,000 rows. App bindings cannot be imported.
One transfer owns its picker, grant and I/O; overlapping calls return `busy`. Backgrounding
review/I/O or destroying its Activity cancels that owner. An interrupted export may leave
a partial plaintext file and says so. These APIs do not upload or sync the vault.

## Host-native vault access

These are Java APIs only, with no `ElizaPasswords` method, so page script cannot reach them.

- **Admission.** `PasswordVaultAccess.setAdmission(context -> ...)`, registered once from
  `Application#onCreate`, is the host's own rule (for example its account owner). Every bridge and
  transfer method that reaches the vault rejects with `not-admitted` when it refuses; `status`,
  `lock` and `openAutofillSettings` do not ask. Autofill fill and save requests get no dataset and
  no prompt, and the fill and save screens close. The rule may run on the main thread (Autofill,
  fill and save screens) or the bridge thread, so it must be fast, must not show UI and must
  return false when it cannot decide. The default admits.
- **Secret surfaces.** `PasswordSurfaces.addListener` reports on the main thread when the first
  secret surface opens, before it draws, and when the last one closes: the unlock prompt, the
  editor and its questions, a revealed password, and the fill and save screens. `visible()` reads
  the current state from any thread. Listeners run inside the open or close, so they must be
  quick, must not throw and must not open a surface.
- **Lock and state.** `lockAndClose()` locks, drops pending fill and save requests and closes the
  editor and a revealed password; open fill and save screens and a pending unlock fail on their
  next step. `exists()` and `unrecoverable()` read the stored state. None of
  them needs a grant or shows a prompt.

`PasswordVaultAccess.get(context).destroyVault()` destroys the vault, readable or not, for host
lifecycle events such as an account-owner revoke. It shows no prompt and needs no grant, because
its caller may have no user present. It deletes the Keystore key first, then the records, revokes
the grant and pending requests, and closes open native surfaces. It throws if deletion failed;
calling it again finishes the job. The host must verify its own authority first and must never
bridge it. The JavaScript `reset` still refuses a readable vault. A copied clip keeps its normal expiry, and a save
that a person confirms and unlocks afterward creates a new vault. A host that migrated custody
destroys each store it opened.

Passkeys are not implemented.

## Verification

- `test/client.node.mjs`: TS normalization, search, the no-secret response rule and error mapping.
- `test/native-host/policy.node.mjs`: JVM tests of `PasswordFormPolicy`, `PasswordMatching`,
  `PasswordGenerator`, `PasswordRequests` and `PasswordEditorPolicy` with synthetic structures.
- `test/android-consumer`: a separate offline sign-in app and provider host exercise native
  save, device-credential unlock, account choice and framework fill. A real Capacitor host
  also tests document-picker export/import, fresh unlock, exact restored values, overlapping
  calls and cancellation on backgrounding or Activity destruction. The offer tests also use
  real framework objects with synthetic targets. Run with
  `node packages/app/scripts/android-native-plugins.ts --serial <emulator> --plugin plugin-native-passwords`.
  The runner creates and removes a disposable user. These tests do not establish trusted-browser,
  biometric, physical-device or user acceptance. Layout artifacts render only the fixture
  views with synthetic data; Android screen-capture protection remains enabled.

Other native credential owners can reuse `SecretSurfaces.revealOwned` for the timed FLAG_SECURE
dialog and secret-surface signal. Supply a current foreground/unlocked owner predicate and close
the returned handle on retirement. A retired handle cannot dismiss a newer surface. Values stay
native; resolve renderer calls with acknowledgement metadata only. This does not grant vault or
credential access and does not change the credential store's authentication policy.
