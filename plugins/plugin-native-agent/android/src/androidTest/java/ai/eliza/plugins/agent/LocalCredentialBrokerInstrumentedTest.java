package ai.eliza.plugins.agent;

import ai.eliza.plugins.agent.contract.LocalCredentialBrokerContract;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class LocalCredentialBrokerInstrumentedTest {
  @Test public void privateSocketContract() throws Exception { LocalCredentialBrokerContract.run(); ai.eliza.plugins.agent.contract.LocalRuntimeHttpContract.run(); }
}
