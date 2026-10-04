package ai.eliza.plugins.agent;

import ai.eliza.plugins.agent.contract.AndroidPreparationContract;
import ai.eliza.plugins.agent.contract.AndroidUpdateStorageContract;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class NativePreparationInstrumentedTest {
    @Test public void cancellationLocksAndUnsafePaths() throws Exception {
        AndroidPreparationContract.run(InstrumentationRegistry.getInstrumentation().getTargetContext());
    }
    @Test public void qualifiedClockPersistsWithinItsBoot() throws Exception {
        AndroidUpdateStorageContract.run(InstrumentationRegistry.getInstrumentation().getTargetContext());
    }
}
