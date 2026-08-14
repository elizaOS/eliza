/**
 * Host-side coverage for Android periodic-wake ownership and reconciliation.
 */
package ai.elizaos.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ElizaWorkSchedulerPolicyTest {

    private static final String SECRET = "native-device-secret";

    @Test
    public void localAndHybridProvisionedTargetsSchedule() {
        assertSchedule(ElizaWorkScheduler.decide(true, "local", SECRET));
        assertSchedule(ElizaWorkScheduler.decide(true, " cloud-hybrid ", SECRET));
    }

    @Test
    public void remoteAndPureCloudTargetsCancelEvenWithAStaleCredential() {
        assertCancel(ElizaWorkScheduler.decide(true, "remote-mac", SECRET), "runtime-not-owned");
        assertCancel(ElizaWorkScheduler.decide(true, "cloud", SECRET), "runtime-not-owned");
        assertCancel(ElizaWorkScheduler.decide(true, "tunnel-to-mobile", SECRET), "runtime-not-owned");
    }

    @Test
    public void missingModeOrCredentialCancels() {
        assertCancel(ElizaWorkScheduler.decide(true, null, SECRET), "runtime-not-owned");
        assertCancel(ElizaWorkScheduler.decide(true, "local", null), "credential-unprovisioned");
        assertCancel(ElizaWorkScheduler.decide(true, "local", "  "), "credential-unprovisioned");
    }

    @Test
    public void disabledBackgroundCancelsAProvisionedLocalTarget() {
        assertCancel(ElizaWorkScheduler.decide(false, "local", SECRET), "background-disabled");
    }

    @Test
    public void reconciliationCallsExactlyOneBackendOperation() {
        RecordingBackend schedule = new RecordingBackend();
        ElizaWorkScheduler.reconcileDecision(
            ElizaWorkScheduler.decide(true, "local", SECRET),
            schedule
        );
        assertEquals(1, schedule.enqueueCalls);
        assertEquals(0, schedule.cancelCalls);

        RecordingBackend cancel = new RecordingBackend();
        ElizaWorkScheduler.reconcileDecision(
            ElizaWorkScheduler.decide(true, "remote-mac", SECRET),
            cancel
        );
        assertEquals(0, cancel.enqueueCalls);
        assertEquals(1, cancel.cancelCalls);
    }

    private static void assertSchedule(ElizaWorkScheduler.Decision decision) {
        assertTrue(decision.shouldSchedule);
        assertEquals("owned-target-provisioned", decision.reason);
        assertEquals(SECRET, decision.deviceSecret);
    }

    private static void assertCancel(ElizaWorkScheduler.Decision decision, String reason) {
        assertFalse(decision.shouldSchedule);
        assertEquals(reason, decision.reason);
        assertNull(decision.deviceSecret);
    }

    private static final class RecordingBackend implements ElizaWorkScheduler.ScheduleBackend {
        int enqueueCalls;
        int cancelCalls;

        @Override
        public void enqueue() {
            enqueueCalls += 1;
        }

        @Override
        public void cancel() {
            cancelCalls += 1;
        }
    }
}
