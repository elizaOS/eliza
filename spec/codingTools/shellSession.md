# Coding shell sessions and approvals

Models destructive shell command one-time confirmation challenges, background shell session lifecycle and output polling offsets, and leased shell output artifacts.

## Story: Gate destructive shell commands, manage background jobs, and page spilled output artifacts

> As the owner, I want destructive shell commands to require a single-use, context-bound, unexpired confirmation challenge, background sessions to stay bounded with monotone incremental polling, and spilled shell outputs to be readable through leased artifact handles.

### Destructive commands require a bound, unexpired, single-use confirmation challenge

Issuing a challenge binds a command digest, canonical working directory, requester identity, the message that asked for the command, and expiration time. The challenge token goes to the owner through a user-facing channel and never into model-visible results. Executing the destructive command requires a matching unexpired challenge redeemed by a later owner message, never the message that issued it, and consumes it immediately so it cannot be replayed.

```quint
type BgStatus = BgNone | BgRunning | BgExited | BgKilled
type ShellSession = {
  clock: int,
  challengeActive: bool,
  challengeDigest: str,
  challengeCwd: str,
  challengeIssuer: str,
  challengeMessage: str,
  challengeExpiresAt: int,
  destructiveRuns: int,
  bgStatus: BgStatus,
  bgStdoutTotal: int,
  bgStdoutCursor: int,
  bgActiveCount: int,
  artifactActive: bool,
  artifactBytes: int,
  artifactExpiresAt: int,
  artifactReads: int
}
pure val initial: ShellSession = {
  clock: 0,
  challengeActive: false,
  challengeDigest: "",
  challengeCwd: "",
  challengeIssuer: "",
  challengeMessage: "",
  challengeExpiresAt: 0,
  destructiveRuns: 0,
  bgStatus: BgNone,
  bgStdoutTotal: 0,
  bgStdoutCursor: 0,
  bgActiveCount: 0,
  artifactActive: false,
  artifactBytes: 0,
  artifactExpiresAt: 0,
  artifactReads: 0
}
pure def canIssueChallenge(s: ShellSession, digest: str, cwd: str, issuer: str, messageId: str): bool =
  digest != "" and cwd != "" and issuer != "" and messageId != ""
pure def issueChallenge(s: ShellSession, digest: str, cwd: str, issuer: str, messageId: str): ShellSession = {
  ...s,
  challengeActive: true,
  challengeDigest: digest,
  challengeCwd: cwd,
  challengeIssuer: issuer,
  challengeMessage: messageId,
  challengeExpiresAt: s.clock + 5
}
pure def canConsumeChallenge(s: ShellSession, digest: str, cwd: str, issuer: str, messageId: str): bool =
  s.challengeActive and s.clock < s.challengeExpiresAt and
  digest == s.challengeDigest and cwd == s.challengeCwd and issuer == s.challengeIssuer and
  messageId != "" and messageId != s.challengeMessage
pure def consumeChallenge(s: ShellSession, digest: str, cwd: str, issuer: str, messageId: str): ShellSession = {
  ...s,
  challengeActive: false,
  challengeDigest: "",
  challengeCwd: "",
  challengeIssuer: "",
  challengeMessage: "",
  challengeExpiresAt: 0,
  destructiveRuns: s.destructiveRuns + 1
}
pure def canAdvanceClock(s: ShellSession, delta: int): bool = delta > 0 and delta <= 10
pure def advanceClock(s: ShellSession, delta: int): ShellSession = {
  ...s,
  clock: s.clock + delta
}
```

### Background shell sessions enforce concurrency caps and monotone incremental output polling

This state machine models a single tracked background session slot (`bgActiveCount` in `{0, 1}`) under the per-conversation cap of 16 sessions. Starting requires the slot to be free and under the cap, output bytes accumulate while running, polling advances the cursor without skipping past total bytes, and exiting or killing releases the active session slot.

```quint
pure def canStartBackground(s: ShellSession): bool =
  s.bgStatus != BgRunning and s.bgActiveCount < 16
pure def startBackground(s: ShellSession): ShellSession = {
  ...s,
  bgStatus: BgRunning,
  bgStdoutTotal: 0,
  bgStdoutCursor: 0,
  bgActiveCount: s.bgActiveCount + 1
}
pure def canAppendBgOutput(s: ShellSession, bytes: int): bool =
  s.bgStatus == BgRunning and bytes > 0 and bytes <= 1000
pure def appendBgOutput(s: ShellSession, bytes: int): ShellSession = {
  ...s,
  bgStdoutTotal: s.bgStdoutTotal + bytes
}
pure def canPollBackground(s: ShellSession, offset: int): bool =
  s.bgStatus != BgNone and offset >= s.bgStdoutCursor and offset <= s.bgStdoutTotal
pure def pollBackground(s: ShellSession, offset: int): ShellSession = {
  ...s,
  bgStdoutCursor: s.bgStdoutTotal
}
pure def canExitBackground(s: ShellSession): bool =
  s.bgStatus == BgRunning and s.bgActiveCount > 0
pure def exitBackground(s: ShellSession): ShellSession = {
  ...s,
  bgStatus: BgExited,
  bgActiveCount: s.bgActiveCount - 1
}
pure def canKillBackground(s: ShellSession): bool =
  s.bgStatus == BgRunning and s.bgActiveCount > 0
pure def killBackground(s: ShellSession): ShellSession = {
  ...s,
  bgStatus: BgKilled,
  bgActiveCount: s.bgActiveCount - 1
}
```

### Background stdin reaches a command interpreter only through the command policy

Text written to a background session's stdin can run as code, and no reading of the session's command can tell every program that executes its input from one that does not, so stdin is checked unless the session's command is known to take it only as data. A session takes stdin as data only when its command, as it was started and before any redaction, is one simple command with no pipe, list, redirection, substitution, glob, variable, assignment, wrapper or path, whose program is one of `cat`, `wc`, `sort`, `uniq`, `head`, `tail`, `tr`, `cut`, `nl`, `grep` (without `-f`), `base64`, `md5sum`, `sha1sum`, `sha256sum`, `sha512sum`, `gzip`, `gunzip`, `xxd`, `od` or `jq`. Every other session's stdin is checked: a write that matches the forbidden-command list is refused, and any other write runs only after the owner confirms that exact text through a one-time challenge in the session's directory. A program that is not on that list, a shell, an interpreter, a wrapper such as `sudo`, `env` or `busybox`, and a program named by a path are all checked, whatever their arguments say.

The forbidden-command list matches commands by tokens, not by prefix: quoting, escapes and line continuations are removed, every command of a `;`, `&&`, `||`, `|`, `&`, newline, subshell, group or substitution list is checked, wrappers such as `env`, `exec`, `sudo`, `nice`, `timeout` and `xargs` are unwrapped, and the scripts of `sh -c`, `eval`, `env -S` and `find -exec` are checked as commands. A rule matches when the command names the same program and carries every flag and argument the rule names. `shutdown`, `reboot`, `halt` and `poweroff` are also destructive commands.

```quint
type StdinTarget = StdinData | StdinChecked
pure def mayWriteBackgroundStdin(target: StdinTarget, forbidden: bool, ownerConfirmed: bool): bool =
  match target {
    | StdinData => true
    | StdinChecked => not(forbidden) and ownerConfirmed
  }
pure def lawCheckedStdinNeedsTheOwner(forbidden: bool): bool =
  not(mayWriteBackgroundStdin(StdinChecked, forbidden, false))
pure def lawForbiddenCheckedStdinIsRefused(ownerConfirmed: bool): bool =
  not(mayWriteBackgroundStdin(StdinChecked, true, ownerConfirmed))
pure def lawConfirmedCheckedStdinIsWritten: bool =
  mayWriteBackgroundStdin(StdinChecked, false, true)
```

### Leased output artifacts allow bounded paging until lease expiration

Spilling large foreground command output registers an immutable byte artifact with a lease expiration. Paging reads are allowed only while the lease is unexpired, the offset lies within the artifact size, and the page limit is within the 20,000-character ceiling.

```quint
pure def canCreateArtifact(s: ShellSession, artifactSize: int): bool =
  artifactSize > 0 and artifactSize <= 10000
pure def createArtifact(s: ShellSession, artifactSize: int): ShellSession = {
  ...s,
  artifactActive: true,
  artifactBytes: artifactSize,
  artifactExpiresAt: s.clock + 10
}
pure def canReadArtifactPage(s: ShellSession, offset: int, limit: int): bool =
  s.artifactActive and s.clock < s.artifactExpiresAt and
  offset >= 0 and offset <= s.artifactBytes and
  limit > 0 and limit <= 20000
pure def readArtifactPage(s: ShellSession, offset: int, limit: int): ShellSession = {
  ...s,
  artifactReads: s.artifactReads + 1
}
pure val digestValues = Set("d1", "d2", "")
pure val cwdValues = Set("/work", "/other")
pure val issuerValues = Set("owner", "guest")
pure val messageIdValues = Set("m1", "m2", "")
pure val deltaValues = Set(0, 1, 6)
pure val bytesValues = Set(10, 50)
pure val offsetValues = Set(0, 10, 50)
pure val artifactSizeValues = Set(0, 100, 500)
pure val limitValues = Set(50, 1000)
```

### Shell session invariants and reachability

For the single tracked background session slot, `bgActiveCount` stays within `[0, 16]` and equals `1` when running and `0` otherwise; output cursors never exceed produced bytes, challenges are consumed on use and never by the message that issued them, and each workflow is reachable.

```quint
pure def alwaysShellSessionValid(s: ShellSession): bool =
  s.clock >= 0 and
  s.destructiveRuns >= 0 and
  s.bgActiveCount >= 0 and s.bgActiveCount <= 16 and
  s.bgStdoutTotal >= 0 and s.bgStdoutCursor >= 0 and s.bgStdoutCursor <= s.bgStdoutTotal and
  s.artifactBytes >= 0 and s.artifactReads >= 0 and
  (s.bgStatus == BgRunning implies s.bgActiveCount == 1) and
  (s.bgStatus != BgRunning implies s.bgActiveCount == 0)
pure def stepChallengeConsumedOnce(before: ShellSession, via: str, after: ShellSession): bool =
  via == "consumeChallenge" implies (
    before.challengeActive and not(after.challengeActive) and after.destructiveRuns == before.destructiveRuns + 1
  )
pure def lawIssuingMessageCannotConfirm(s: ShellSession, digest: str, cwd: str, issuer: str, messageId: str): bool =
  messageId == s.challengeMessage implies not(canConsumeChallenge(s, digest, cwd, issuer, messageId))
pure def stepBgCursorMonotone(before: ShellSession, via: str, after: ShellSession): bool =
  via == "pollBackground" implies after.bgStdoutCursor >= before.bgStdoutCursor
pure def sometimesDestructiveConfirmed(s: ShellSession): bool = s.destructiveRuns > 0
pure def sometimesBgPolledAndKilled(s: ShellSession): bool = s.bgStatus == BgKilled and s.bgStdoutCursor > 0
pure def sometimesArtifactPaged(s: ShellSession): bool = s.artifactReads > 0
```
