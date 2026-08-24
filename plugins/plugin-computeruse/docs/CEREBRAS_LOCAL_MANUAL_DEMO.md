# Cerebras local manual-demo readiness packet

This packet is inert by default and is limited to two disposable fixtures owned
by the test run:

- a local AppKit fixture controlled only through app-scoped semantic AX;
- a local fixture browser target controlled only through CDP.

It never enables global HID, invokes the private SkyLight helper, changes TCC,
or targets personal apps or data.

## Exact approval fingerprint

```text
cerebras-ax-cdp-v1:fixture-only:semantic-ax-and-cdp:no-global-hid:no-private-helper
```

## Approval-gated command

Do not run this command until Nubs explicitly approves the exact fingerprint
above:

```bash
CEREBRAS_API_KEY='<already-configured-secret>' \
RUN_CEREBRAS_COMPUTER_USE_MANUAL_DEMO=1 \
CEREBRAS_COMPUTER_USE_MANUAL_DEMO_FINGERPRINT='cerebras-ax-cdp-v1:fixture-only:semantic-ax-and-cdp:no-global-hid:no-private-helper' \
bun run --cwd plugins/plugin-computeruse demo:manual:cerebras
```

The API key must come from the existing secret environment and must not be
printed, copied into a file, or included in receipts. The AX test uses an
isolated approval-config path. Temporary fixture artifacts remain available for
inspection or normal system cleanup.

## Expected evidence

- Cerebras plans only against fixture screenshots and semantic state.
- AX receipts match the fixture PID, exact window, observation, and bounds.
- Browser receipts match the fresh CDP target and observation.
- Each consequential fixture action gets exact command/parameter approval.
- Pointer position remains unchanged.
- Stale, malformed, and wrong-target requests refuse without dispatch.
- Store packaging contains no private-helper artifact or enablement.
