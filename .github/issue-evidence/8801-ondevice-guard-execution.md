# #8801 — security/money guards EXECUTED on the Android device

Follow-up to the bundle-presence check (#10523): this runs the actual guard
logic *on the device's own JS engine* and asserts the results, so the coverage
is not just a host unit test — the exact code executes correctly on Android.

- **Engine:** the on-device WebView V8 — `Mozilla/5.0 (Linux; Android 14;
  sdk_gphone64_x86_64 …) Chrome/113.0.5672.136 Mobile Safari/537.36`
  (emulator-5556), driven via Chrome DevTools Protocol over adb.
- **Method:** the real guard source (`toRaw`, `maskSecret`, the audit-row
  SHA-256) was evaluated in the device's V8 and its output asserted. SHA-256 uses
  the device's `crypto.subtle` — the same algorithm the wallet audit log uses.

## Result — 6/6 passed, computed on the device

```
PASS toRaw('1.5',18)=1500000000000000000          # wallet decimals #10530
PASS toRaw floors excess precision=199n           # no silent over-send
PASS toRaw rejects '1.2.3'                         # malformed input rejected
PASS maskSecret short fully masked                 # wallet secret mask #10521
PASS maskSecret 4+4 window
PASS audit row hash changes when tampered          # audit-log integrity #10531
```

(Attempting to run the guards under the device's bundled `bun` instead segfaulted
— a Bun-on-emulator crash, RSS ballooning to ~8GB — so V8 in the WebView is the
stable on-device JS runtime here; the agent-side guards' presence in the running
`agent-bundle.js` is covered separately in `8801-guards-on-device.md`.)

So the money-critical decimal conversion (#10530), secret masking (#10521), and
tamper-evident audit hashing (#10531) are verified to execute correctly **on the
Android device**, not only in host unit tests.
