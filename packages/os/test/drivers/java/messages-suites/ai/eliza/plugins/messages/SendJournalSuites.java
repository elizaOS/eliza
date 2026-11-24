// spec/os/android/messages.md, "A repeated operation ID answers its journal record and never sends again"; spec/os/android/messages.md, "A message's status is supported by the evidence of every part, and an interrupted send reads unknown"; spec/os/android/voicemail.md, "The carrier is ready only when a source is configured, and unsupported when every source is disabled or none exists"
package ai.eliza.plugins.messages;

import ai.eliza.plugins.messages.vvm.OmtpSmsTest;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.Comparator;
import org.junit.Test;

public final class SendJournalSuites {
  public static void main(String[] args) throws Exception {
    for (Class<?> suite : new Class<?>[] { SmsSendJournalTest.class, MmsSendJournalTest.class, OmtpSmsTest.class }) {
      Method[] methods = suite.getMethods();
      Arrays.sort(methods, Comparator.comparing(Method::getName));
      for (Method method : methods) {
        if (!method.isAnnotationPresent(Test.class)) continue;
        String name = suite.getSimpleName() + "." + method.getName();
        try {
          method.invoke(suite.getDeclaredConstructor().newInstance());
          System.out.println("passed " + name);
        } catch (InvocationTargetException thrown) {
          System.out.println("failed " + name + " " + thrown.getCause());
        }
      }
    }
  }
}
