package ai.eliza.plugins.agent;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
public final class AndroidUpdateStorageInstrumentedTest {
 @Test public void directoryDurabilityAndQualifiedClock()throws Exception {
  ai.eliza.plugins.agent.contract.AndroidUpdateStorageContract.run(InstrumentationRegistry.getInstrumentation().getTargetContext());
 }
 @Test public void preparationCancellationAndLocking()throws Exception {
  ai.eliza.plugins.agent.contract.AndroidPreparationContract.run(InstrumentationRegistry.getInstrumentation().getTargetContext());
 }
}
