# Issue #11506 FGS Restart Crash

Branch: `fix/11506-fgs-restart-crash`

Scope:

- Handles Android 12+ `ForegroundServiceStartNotAllowedException` during a background sticky restart of `ElizaAgentService`.
- Stops the service cleanly instead of crash-looping when AMS restarts it after a low-memory kill with no foreground activity.
- Records `fgs-start-denied` and `service-start-refused-fgs-denied` diagnostic events so the path is visible in `agent-restart-diagnostics.jsonl`.
- Adds an Android instrumentation assertion that only the real framework foreground-start denial is swallowed; unrelated `IllegalStateException` failures still throw.

Root-cause evidence already captured on #11506:

- Pixel 6a on-device forensics classified the original churn as primary LMK `LOW_MEMORY` kills at roughly 3.2-3.3 GB RSS plus a secondary foreground-service restart crash cascade.
- Evidence branch: `evidence/11506-restart-repro`.
- Issue comments include exit-info dumps, dropbox crash stacks, pid/meminfo timelines, filtered logcat, screenshots, and the later fresh-`develop` stability/re-extraction checks.

Validation:

- `git fetch origin && git rebase origin/develop` - passed.
- `bun run install:light` - passed in the clean PR worktree to install Capacitor/Gradle workspace dependencies without artifact sync.
- `ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1 ./gradlew :app:testDebugUnitTest :app:compileDebugAndroidTestJavaWithJavac` from `packages/app-core/platforms/android` - passed: build successful, 528 actionable tasks executed. `:app:testDebugUnitTest` is `NO-SOURCE`; `:app:compileDebugAndroidTestJavaWithJavac` compiled the new instrumentation assertion.
- `ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB=1 ./gradlew :app:lintDebug` from `packages/app-core/platforms/android` - failed on pre-existing Android resource lint errors, first failure `app/src/main/res/values/styles.xml:32 android:windowSplashScreenBackground requires API level 31 (current min is 26) [NewApi]`; not introduced by this branch.
- `git diff --check origin/develop...HEAD` - run before PR.

N/A evidence:

- Live LLM trajectories: N/A - Android service lifecycle fix, no model/prompt behavior changed.
- UI screenshots/video for this code branch: N/A - user-visible restart behavior requires the physical Pixel 6a LMK repro already captured in the issue/evidence branch.
