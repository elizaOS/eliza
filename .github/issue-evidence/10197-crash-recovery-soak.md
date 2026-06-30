# #10197 — on-device agent crash/restart recovery soak

#10197 flags *"no crash-recovery soak suite, and no device-connected crash/
restart e2e for the local + cloud agent."* PR #10508 showed a **single**
agent-crash recovery on-device; this is the **multi-cycle soak**: repeatedly
kill the agent the device is talking to and assert the app UI survives and
reconnects every time.

## Method

App onboarded to home on an `android-34` emulator, talking to the host agent
(`serve-real-local-agent.ts`) over `adb reverse tcp:31337`. Per cycle:

1. Record the app process pid (`adb shell pidof ai.elizaos.app`).
2. **Kill the agent** (`pkill -9 -f serve-real-local-agent`), confirm
   `/api/health` goes unreachable.
3. While the agent is down, assert the app **stayed rendered** (body content
   present, no React error boundary) and the **app pid is unchanged** (the
   WebView/host process did not crash or restart).
4. **Restart the agent**, wait for `/api/health` `ready:true`.
5. Assert the app **reconnected** (the home launcher surface is present again)
   and the app pid is *still* unchanged.

## Result — 4/4 cycles clean

```
initial app pid: 31236 | agent healthy: true
cycle1: agent killed(down=true) | app pid 31236->31236 alive=true rendered(len=795,errBoundary=false)
        agent restarted(up=true) | app pid=31236 | home reconnected=true
cycle2: agent killed(down=true) | app pid 31236->31236 alive=true rendered(len=790,errBoundary=false)
        agent restarted(up=true) | app pid=31236 | home reconnected=true
cycle3: agent killed(down=true) | app pid 31236->31236 alive=true rendered(len=790,errBoundary=false)
        agent restarted(up=true) | app pid=31236 | home reconnected=true
cycle4: agent killed(down=true) | app pid 31236->31236 alive=true rendered(len=790,errBoundary=false)
        agent restarted(up=true) | app pid=31236 | home reconnected=true

app pid stable across all cycles: true (start 31236, end 31236)
app stayed rendered through every agent-down (no crash/white-screen): true
app reconnected to home after every agent-restart: true
```

**Conclusion:** the app survives repeated backend crash/restart cycles — the UI
never crashes or white-screens when the agent dies, the app process is stable
across all four cycles, and it reconnects to a working home each time the agent
comes back. Combined with #10508 (single recovery), #10484 (bg/fg heap soak),
and the #10196 memory walk (PSS bounded over 104 navigations), the on-device
local-agent stability surface holds under the crash/restart soak #10197 asks for.
