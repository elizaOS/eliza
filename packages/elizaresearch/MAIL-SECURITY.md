# elizaresearch.ai mail security baseline

The company domain is the recovery, reviewer-contact, and security-notification
channel for every store account, so its mail posture is a security control, not
a convenience. The DNS half of that baseline is machine-checkable; the Workspace
admin half is human-only and recorded here as a runbook.

Never put private addresses, recovery codes, DNS-provider credentials, or raw
DMARC report contents in an issue, PR, log, or agent transcript. Record the
ownership facts below in the private ops vault and reference them by name only.

## Automated DNS check

```bash
bun run --cwd packages/elizaresearch mail:security          # elizaresearch.ai
node packages/elizaresearch/mail-security.mjs example.test  # any other domain
```

The command resolves live DNS and exits non-zero when a control fails. It
verifies four things:

| Check | Requirement |
| --- | --- |
| `mx` | every MX host is Google Workspace (`smtp.google.com`) |
| `spf` | exactly one `v=spf1` record, includes `_spf.google.com`, ends in `~all` or `-all` |
| `dkim` | exactly one 2048-bit key on the `google` selector, non-empty `p=` |
| `dmarc` | exactly one `v=DMARC1` record with a valid `p=` and a `rua=mailto:` destination |

`evaluateMailSecurity` is a pure function over resolved records, so the contract
is covered by `mail-security.test.mjs` without network access.

## Publishing DMARC (the current gap)

`_dmarc.elizaresearch.ai` returns no policy today. Start in monitor mode so
alignment can be reviewed before any mail is affected:

1. Create a TXT record at host `_dmarc` with value:
   `v=DMARC1; p=none; rua=mailto:<aggregate-report-mailbox>; fo=1; adkim=r; aspf=r`
   The `rua` mailbox must be a company-controlled address on this domain, or an
   external destination that has published the matching
   `elizaresearch.ai._report._dmarc.<external-domain>` authorization record.
2. Wait for propagation and confirm with `bun run --cwd packages/elizaresearch mail:security`.
3. Collect at least two weeks of aggregate reports. Confirm that all legitimate
   sources pass SPF **or** DKIM with identifier alignment before advancing.
4. Advance to `p=quarantine; pct=25`, widen `pct` to 100, then move to
   `p=reject` only after a full reporting window with no legitimate failures.

Do not advance enforcement while any unaligned legitimate sender remains, and
re-run step 3 whenever a new sending service is added.

## Human-only Workspace admin checklist

These cannot be verified from DNS and must be confirmed in the Google Workspace
admin console by a person with super-admin rights.

- [ ] **Super-admin custody.** Confirm the named super-admin account, plus at
      least one company-controlled break-glass super-admin that is not a
      personal address and is not the same person's only account.
- [ ] **2-Step Verification.** Enforce 2SV for all users, with security keys
      required for admin roles. Store backup codes in the ops vault under
      sealed, dual-custody access; never in mail, chat, or this repository.
- [ ] **Recovery paths.** Set the account recovery phone and email to
      company-controlled destinations, and verify the domain-level recovery
      contact with the registrar and DNS provider separately.
- [ ] **Least-privilege aliases/groups.** Create `admin@`, `billing@`,
      `security@`, and `store-review@` as groups, not shared mailboxes. Restrict
      posting to authenticated members where the group is not a public contact,
      and grant each group only the console roles it needs — store-review and
      billing must not carry admin roles.
- [ ] **Delivery proof.** Send and receive one real message on each alias, then
      inspect the received headers for `spf=pass`, `dkim=pass`, and
      `dmarc=pass` with aligned identifiers. Confirm at least one live store
      notification (Apple, Google Play, Microsoft) is received at its alias.
- [ ] **Rotation ownership.** Record, in redacted form, who owns rotation for
      the DKIM key, the registrar and DNS-provider credentials, the break-glass
      account, and the backup codes, along with the next rotation date.

Re-run the automated check after any DNS or sending-service change, and re-walk
this checklist whenever admin ownership changes.
