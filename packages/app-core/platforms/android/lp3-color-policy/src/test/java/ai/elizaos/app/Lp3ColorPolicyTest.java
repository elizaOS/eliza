/**
 * Exercises the LP3 color guard with deterministic settings and scheduler
 * fakes; Android services and the physical panel are verified separately.
 */
package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class Lp3ColorPolicyTest {
    @Test
    public void receiverAcceptsOnlyBootPackageReplaceAndExplicitCommands() {
        assertTrue(Lp3ColorPolicy.acceptsTrigger("android.intent.action.BOOT_COMPLETED"));
        assertTrue(
            Lp3ColorPolicy.acceptsTrigger("android.intent.action.MY_PACKAGE_REPLACED")
        );
        assertTrue(
            Lp3ColorPolicy.acceptsTrigger(
                "ai.elizaos.app.action.ENABLE_LP3_COLOR_POLICY"
            )
        );
        assertTrue(
            Lp3ColorPolicy.acceptsTrigger(
                "ai.elizaos.app.action.DISABLE_LP3_COLOR_POLICY"
            )
        );
        assertTrue(
            Lp3ColorPolicy.acceptsTrigger(
                "ai.elizaos.app.action.SYNC_LP3_COLOR_POLICY"
            )
        );
        assertFalse(Lp3ColorPolicy.acceptsTrigger(null));
        assertFalse(Lp3ColorPolicy.acceptsTrigger("android.intent.action.SCREEN_ON"));
    }

    @Test
    public void operatorCommandsCannotAliasBootOrUnknownActions() {
        assertEquals(
            Lp3ColorPolicy.OperatorCommand.ENABLE,
            Lp3ColorPolicy.operatorCommand(Lp3ColorPolicy.ACTION_ENABLE)
        );
        assertEquals(
            Lp3ColorPolicy.OperatorCommand.DISABLE,
            Lp3ColorPolicy.operatorCommand(Lp3ColorPolicy.ACTION_DISABLE)
        );
        assertEquals(
            Lp3ColorPolicy.OperatorCommand.SYNC,
            Lp3ColorPolicy.operatorCommand(Lp3ColorPolicy.ACTION_SYNC)
        );
        assertEquals(
            Lp3ColorPolicy.OperatorCommand.NONE,
            Lp3ColorPolicy.operatorCommand(Lp3ColorPolicy.ACTION_BOOT_COMPLETED)
        );
        assertEquals(
            Lp3ColorPolicy.OperatorCommand.NONE,
            Lp3ColorPolicy.operatorCommand(null)
        );
    }

    @Test
    public void privateOptInCommitFailureStopsBeforeAnySuccessCanBeReported() {
        List<Boolean> attempted = new ArrayList<>();
        IllegalStateException error = assertThrows(
            IllegalStateException.class,
            () ->
                Lp3ColorPolicy.persistOptIn(
                    enabled -> {
                        attempted.add(enabled);
                        return false;
                    },
                    false
                )
        );
        assertEquals("Could not persist LP3 color policy opt-in", error.getMessage());
        assertEquals(List.of(false), attempted);
    }

    @Test
    public void stickyNullIntentRestartRequiresPriorInitializationAndCurrentEligibility() {
        assertTrue(
            Lp3ColorPolicy.shouldKeepStickyRestart(
                true,
                Lp3ColorPolicy.Decision.ELIGIBLE
            )
        );
        assertFalse(
            Lp3ColorPolicy.shouldKeepStickyRestart(
                false,
                Lp3ColorPolicy.Decision.ELIGIBLE
            )
        );
        assertFalse(
            Lp3ColorPolicy.shouldKeepStickyRestart(
                true,
                Lp3ColorPolicy.Decision.MISSING_PERMISSION
            )
        );
    }

    @Test
    public void disabledBuildNeverReadsOrWritesSecureSettings() {
        FakeState state = eligibleState();
        state.buildEnabled = false;

        assertEquals(Lp3ColorPolicy.Outcome.BUILD_DISABLED, Lp3ColorPolicy.reconcile(state));
        assertEquals(0, state.secureReads);
        assertEquals(List.of(), state.writes);
    }

    @Test
    public void nonLightPhoneNeverReadsOrWritesSecureSettings() {
        FakeState state = eligibleState();
        state.model = "Pixel 10";

        assertEquals(Lp3ColorPolicy.Outcome.WRONG_DEVICE, Lp3ColorPolicy.reconcile(state));
        assertEquals(0, state.secureReads);
        assertEquals(List.of(), state.writes);
    }

    @Test
    public void optedOutDeviceNeverReadsOrWritesSecureSettings() {
        FakeState state = eligibleState();
        state.optedIn = false;

        assertEquals(Lp3ColorPolicy.Outcome.OPTED_OUT, Lp3ColorPolicy.reconcile(state));
        assertEquals(0, state.secureReads);
        assertEquals(List.of(), state.writes);
    }

    @Test
    public void missingPermissionNeverReadsOrWritesSecureSettings() {
        FakeState state = eligibleState();
        state.hasPermission = false;

        assertEquals(
            Lp3ColorPolicy.Outcome.MISSING_PERMISSION,
            Lp3ColorPolicy.reconcile(state)
        );
        assertEquals(0, state.secureReads);
        assertEquals(List.of(), state.writes);
    }

    @Test
    public void missingNotificationPermissionNeverRunsAnInvisibleGuard() {
        FakeState state = eligibleState();
        state.hasNotificationPermission = false;

        assertEquals(
            Lp3ColorPolicy.Outcome.MISSING_NOTIFICATION_PERMISSION,
            Lp3ColorPolicy.reconcile(state)
        );
        assertEquals(0, state.secureReads);
        assertEquals(List.of(), state.writes);
    }

    @Test
    public void blockedAppNotificationsNeverReadOrWriteSecureSettings() {
        FakeState state = eligibleState();
        state.hasNotificationDisclosure = false;

        assertEquals(
            Lp3ColorPolicy.Outcome.MISSING_NOTIFICATION_DISCLOSURE,
            Lp3ColorPolicy.reconcile(state)
        );
        assertEquals(0, state.secureReads);
        assertEquals(List.of(), state.writes);
    }

    @Test
    public void notificationDisclosureAllowsFirstChannelButRejectsAppAndChannelBlocks() {
        assertTrue(
            Lp3ColorPolicy.hasVisibleNotificationDisclosure(true, false, false)
        );
        assertTrue(
            Lp3ColorPolicy.hasVisibleNotificationDisclosure(true, true, false)
        );
        assertFalse(
            Lp3ColorPolicy.hasVisibleNotificationDisclosure(false, false, false)
        );
        assertFalse(
            Lp3ColorPolicy.hasVisibleNotificationDisclosure(false, true, false)
        );
        assertFalse(
            Lp3ColorPolicy.hasVisibleNotificationDisclosure(true, true, true)
        );
    }

    @Test
    public void notificationStateFilterRejectsSpoofAndIrrelevantChannelEvents() {
        assertTrue(
            Lp3ColorPolicy.acceptsNotificationStateChange(
                Lp3ColorPolicy.ACTION_APP_NOTIFICATION_BLOCK_STATE_CHANGED,
                null
            )
        );
        assertTrue(
            Lp3ColorPolicy.acceptsNotificationStateChange(
                Lp3ColorPolicy.ACTION_NOTIFICATION_CHANNEL_BLOCK_STATE_CHANGED,
                Lp3ColorPolicy.NOTIFICATION_CHANNEL_ID
            )
        );
        assertFalse(
            Lp3ColorPolicy.acceptsNotificationStateChange(
                Lp3ColorPolicy.ACTION_NOTIFICATION_CHANNEL_BLOCK_STATE_CHANGED,
                "unrelated"
            )
        );
        assertFalse(
            Lp3ColorPolicy.acceptsNotificationStateChange(
                Lp3ColorPolicy.ACTION_NOTIFICATION_CHANNEL_BLOCK_STATE_CHANGED,
                null
            )
        );
        assertFalse(
            Lp3ColorPolicy.acceptsNotificationStateChange(
                "example.app.action.APP_BLOCK_STATE_CHANGED",
                Lp3ColorPolicy.NOTIFICATION_CHANNEL_ID
            )
        );
        assertFalse(Lp3ColorPolicy.acceptsNotificationStateChange(null, null));
    }

    @Test
    public void notificationRecoveryDoesNotRepromptWhenDisclosureIsBlocked() {
        assertTrue(
            Lp3ColorPolicy.canRecoverThroughNotificationState(
                Lp3ColorPolicy.Decision.ELIGIBLE
            )
        );
        assertTrue(
            Lp3ColorPolicy.canRecoverThroughNotificationState(
                Lp3ColorPolicy.Decision.MISSING_NOTIFICATION_PERMISSION
            )
        );
        assertTrue(
            Lp3ColorPolicy.canRecoverThroughNotificationState(
                Lp3ColorPolicy.Decision.MISSING_NOTIFICATION_DISCLOSURE
            )
        );
        assertFalse(
            Lp3ColorPolicy.canRecoverThroughNotificationState(
                Lp3ColorPolicy.Decision.OPTED_OUT
            )
        );
        assertTrue(
            Lp3ColorPolicy.shouldRequestPostNotifications(
                Lp3ColorPolicy.Decision.MISSING_NOTIFICATION_PERMISSION,
                false
            )
        );
        assertFalse(
            Lp3ColorPolicy.shouldRequestPostNotifications(
                Lp3ColorPolicy.Decision.MISSING_NOTIFICATION_PERMISSION,
                true
            )
        );
        assertFalse(
            Lp3ColorPolicy.shouldRequestPostNotifications(
                Lp3ColorPolicy.Decision.MISSING_NOTIFICATION_DISCLOSURE,
                false
            )
        );
    }

    @Test
    public void notificationReceiverRegistrationIsIdempotentAndReversible() {
        Lp3ColorPolicy.LifecycleRegistration registration =
            new Lp3ColorPolicy.LifecycleRegistration();
        int[] registered = {0};
        int[] unregistered = {0};
        Lp3ColorPolicy.RegistrationHooks hooks = new Lp3ColorPolicy.RegistrationHooks() {
            @Override
            public void register() {
                registered[0] += 1;
            }

            @Override
            public void unregister() {
                unregistered[0] += 1;
            }
        };

        registration.update(true, hooks);
        registration.update(true, hooks);
        assertTrue(registration.isRegistered());
        assertEquals(1, registered[0]);
        assertEquals(0, unregistered[0]);

        registration.update(false, hooks);
        registration.update(false, hooks);
        assertFalse(registration.isRegistered());
        assertEquals(1, registered[0]);
        assertEquals(1, unregistered[0]);

        registration.update(true, hooks);
        assertTrue(registration.isRegistered());
        assertEquals(2, registered[0]);
    }

    @Test
    public void failedRegistrationTransitionsRetainTheTruthfulLifecycleState() {
        Lp3ColorPolicy.LifecycleRegistration failedRegister =
            new Lp3ColorPolicy.LifecycleRegistration();
        Lp3ColorPolicy.RegistrationHooks registerFailure =
            new Lp3ColorPolicy.RegistrationHooks() {
                @Override
                public void register() {
                    throw new IllegalStateException("register failed");
                }

                @Override
                public void unregister() {}
            };
        assertThrows(
            IllegalStateException.class,
            () -> failedRegister.update(true, registerFailure)
        );
        assertFalse(failedRegister.isRegistered());

        Lp3ColorPolicy.LifecycleRegistration failedUnregister =
            new Lp3ColorPolicy.LifecycleRegistration();
        failedUnregister.update(
            true,
            new Lp3ColorPolicy.RegistrationHooks() {
                @Override
                public void register() {}

                @Override
                public void unregister() {}
            }
        );
        assertThrows(
            IllegalStateException.class,
            () ->
                failedUnregister.update(
                    false,
                    new Lp3ColorPolicy.RegistrationHooks() {
                        @Override
                        public void register() {}

                        @Override
                        public void unregister() {
                            throw new IllegalStateException("unregister failed");
                        }
                    }
                )
        );
        assertTrue(failedUnregister.isRegistered());
    }

    @Test
    public void optOutAndPermissionRevokesMakeTheNextReconcileIneligible() {
        FakeState optedOut = eligibleState();
        assertEquals(
            Lp3ColorPolicy.Outcome.ALREADY_CORRECT,
            Lp3ColorPolicy.reconcile(optedOut)
        );
        optedOut.optedIn = false;
        assertEquals(Lp3ColorPolicy.Outcome.OPTED_OUT, Lp3ColorPolicy.reconcile(optedOut));
        assertEquals(2, optedOut.secureReads);

        FakeState revoked = eligibleState();
        assertEquals(
            Lp3ColorPolicy.Outcome.ALREADY_CORRECT,
            Lp3ColorPolicy.reconcile(revoked)
        );
        revoked.hasPermission = false;
        assertEquals(
            Lp3ColorPolicy.Outcome.MISSING_PERMISSION,
            Lp3ColorPolicy.reconcile(revoked)
        );
        assertEquals(2, revoked.secureReads);

        FakeState notificationsRevoked = eligibleState();
        assertEquals(
            Lp3ColorPolicy.Outcome.ALREADY_CORRECT,
            Lp3ColorPolicy.reconcile(notificationsRevoked)
        );
        notificationsRevoked.hasNotificationPermission = false;
        assertEquals(
            Lp3ColorPolicy.Outcome.MISSING_NOTIFICATION_PERMISSION,
            Lp3ColorPolicy.reconcile(notificationsRevoked)
        );
        assertEquals(2, notificationsRevoked.secureReads);

        FakeState notificationsBlocked = eligibleState();
        assertEquals(
            Lp3ColorPolicy.Outcome.ALREADY_CORRECT,
            Lp3ColorPolicy.reconcile(notificationsBlocked)
        );
        notificationsBlocked.hasNotificationDisclosure = false;
        assertEquals(
            Lp3ColorPolicy.Outcome.MISSING_NOTIFICATION_DISCLOSURE,
            Lp3ColorPolicy.reconcile(notificationsBlocked)
        );
        assertEquals(2, notificationsBlocked.secureReads);
    }

    @Test
    public void repairsBothDaltonizerSettingsInSafeOrder() {
        FakeState state = eligibleState();
        state.enabled = 1;
        state.mode = 0;

        assertEquals(Lp3ColorPolicy.Outcome.REPAIRED, Lp3ColorPolicy.reconcile(state));
        assertEquals(List.of("enabled=0", "mode=-1"), state.writes);
    }

    @Test
    public void repairsOnlyTheMismatchedSetting() {
        FakeState state = eligibleState();
        state.enabled = 0;
        state.mode = 0;

        assertEquals(Lp3ColorPolicy.Outcome.REPAIRED, Lp3ColorPolicy.reconcile(state));
        assertEquals(List.of("mode=-1"), state.writes);
    }

    @Test
    public void correctStateAndObserverReplayDoNotWrite() {
        FakeState state = eligibleState();

        assertEquals(
            Lp3ColorPolicy.Outcome.ALREADY_CORRECT,
            Lp3ColorPolicy.reconcile(state)
        );
        assertEquals(
            Lp3ColorPolicy.Outcome.ALREADY_CORRECT,
            Lp3ColorPolicy.reconcile(state)
        );
        assertEquals(List.of(), state.writes);
    }

    @Test
    public void rejectedSettingsWriteFailsLoudly() {
        FakeState state = eligibleState();
        state.enabled = 1;
        state.acceptEnabledWrite = false;

        Lp3ColorPolicy.SettingsWriteException error = assertThrows(
            Lp3ColorPolicy.SettingsWriteException.class,
            () -> Lp3ColorPolicy.reconcile(state)
        );
        assertEquals(
            "SettingsProvider rejected accessibility_display_daltonizer_enabled=0",
            error.getMessage()
        );
    }

    @Test
    public void rejectedSecondWriteSurfacesAfterTheSafeFirstWrite() {
        FakeState state = eligibleState();
        state.enabled = 1;
        state.mode = 0;
        state.acceptModeWrite = false;

        Lp3ColorPolicy.SettingsWriteException error = assertThrows(
            Lp3ColorPolicy.SettingsWriteException.class,
            () -> Lp3ColorPolicy.reconcile(state)
        );
        assertEquals(
            "SettingsProvider rejected accessibility_display_daltonizer=-1",
            error.getMessage()
        );
        assertEquals(List.of("enabled=0", "mode=-1"), state.writes);
        assertEquals(0, state.enabled);
        assertEquals(0, state.mode);
    }

    @Test
    public void successfulWritesMustPassFinalReadback() {
        FakeState state = eligibleState();
        state.enabled = 1;
        state.retainEnabledWrite = false;

        Lp3ColorPolicy.SettingsReadbackException error = assertThrows(
            Lp3ColorPolicy.SettingsReadbackException.class,
            () -> Lp3ColorPolicy.reconcile(state)
        );
        assertEquals(
            "SettingsProvider readback mismatch: "
                + "accessibility_display_daltonizer_enabled=1, "
                + "accessibility_display_daltonizer=-1",
            error.getMessage()
        );
        assertEquals(List.of("enabled=0"), state.writes);
    }

    @Test
    public void retainedModeMismatchAlsoFailsFinalReadback() {
        FakeState state = eligibleState();
        state.enabled = 1;
        state.mode = 0;
        state.retainModeWrite = false;

        Lp3ColorPolicy.SettingsReadbackException error = assertThrows(
            Lp3ColorPolicy.SettingsReadbackException.class,
            () -> Lp3ColorPolicy.reconcile(state)
        );
        assertEquals(
            "SettingsProvider readback mismatch: "
                + "accessibility_display_daltonizer_enabled=0, "
                + "accessibility_display_daltonizer=0",
            error.getMessage()
        );
        assertEquals(List.of("enabled=0", "mode=-1"), state.writes);
    }

    @Test
    public void debounceKeepsOnlyTheLatestRepairRequest() {
        FakeScheduler scheduler = new FakeScheduler();
        int[] repairs = {0};
        Lp3ColorPolicy.Debouncer debouncer = new Lp3ColorPolicy.Debouncer(
            scheduler,
            () -> repairs[0] += 1,
            150L
        );

        debouncer.request();
        debouncer.request();
        debouncer.request();

        assertEquals(1, scheduler.pending.size());
        assertEquals(150L, scheduler.lastDelayMillis);
        scheduler.runPending();
        assertEquals(1, repairs[0]);

        debouncer.request();
        debouncer.cancel();
        scheduler.runPending();
        assertEquals(1, repairs[0]);
    }

    @Test
    public void observerBurstAndOwnWriteCallbacksConvergeWithoutALoop() {
        FakeState state = eligibleState();
        state.enabled = 1;
        state.mode = 0;
        FakeScheduler scheduler = new FakeScheduler();
        int[] reconciliations = {0};
        Lp3ColorPolicy.Debouncer debouncer = new Lp3ColorPolicy.Debouncer(
            scheduler,
            () -> {
                reconciliations[0] += 1;
                Lp3ColorPolicy.reconcile(state);
            },
            150L
        );

        debouncer.request();
        debouncer.request();
        debouncer.request();
        scheduler.runPending();
        assertEquals(1, reconciliations[0]);
        assertEquals(List.of("enabled=0", "mode=-1"), state.writes);

        debouncer.request();
        debouncer.request();
        scheduler.runPending();
        assertEquals(2, reconciliations[0]);
        assertEquals(List.of("enabled=0", "mode=-1"), state.writes);
        assertEquals(6, state.secureReads);
    }

    private static FakeState eligibleState() {
        return new FakeState();
    }

    private static final class FakeState implements Lp3ColorPolicy.State {
        boolean buildEnabled = true;
        String manufacturer = " Light ";
        String model = "tlp301";
        boolean optedIn = true;
        boolean hasPermission = true;
        boolean hasNotificationPermission = true;
        boolean hasNotificationDisclosure = true;
        int enabled = 0;
        int mode = -1;
        boolean acceptEnabledWrite = true;
        boolean acceptModeWrite = true;
        boolean retainEnabledWrite = true;
        boolean retainModeWrite = true;
        int secureReads;
        final List<String> writes = new ArrayList<>();

        @Override
        public boolean buildEnabled() {
            return buildEnabled;
        }

        @Override
        public String manufacturer() {
            return manufacturer;
        }

        @Override
        public String model() {
            return model;
        }

        @Override
        public boolean optedIn() {
            return optedIn;
        }

        @Override
        public boolean hasWriteSecureSettings() {
            return hasPermission;
        }

        @Override
        public boolean hasPostNotificationsPermission() {
            return hasNotificationPermission;
        }

        @Override
        public boolean hasVisibleNotificationDisclosure() {
            return hasNotificationDisclosure;
        }

        @Override
        public int colorCorrectionEnabled() {
            secureReads += 1;
            return enabled;
        }

        @Override
        public int colorCorrectionMode() {
            secureReads += 1;
            return mode;
        }

        @Override
        public boolean writeColorCorrectionEnabled(int value) {
            writes.add("enabled=" + value);
            if (acceptEnabledWrite && retainEnabledWrite) enabled = value;
            return acceptEnabledWrite;
        }

        @Override
        public boolean writeColorCorrectionMode(int value) {
            writes.add("mode=" + value);
            if (acceptModeWrite && retainModeWrite) mode = value;
            return acceptModeWrite;
        }
    }

    private static final class FakeScheduler implements Lp3ColorPolicy.Scheduler {
        final List<Runnable> pending = new ArrayList<>();
        long lastDelayMillis;

        @Override
        public void remove(Runnable task) {
            pending.removeIf(candidate -> candidate == task);
        }

        @Override
        public void postDelayed(Runnable task, long delayMillis) {
            pending.add(task);
            lastDelayMillis = delayMillis;
        }

        void runPending() {
            List<Runnable> snapshot = List.copyOf(pending);
            pending.clear();
            for (Runnable task : snapshot) task.run();
        }
    }
}
