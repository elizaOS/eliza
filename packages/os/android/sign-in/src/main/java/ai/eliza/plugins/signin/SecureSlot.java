// spec/os/android/deepLinks.md, "Each capture keeps its own receipt, and only a newer capture takes the slot"; spec/os/signIn/browserReturn.md, "Story: Complete a browser sign-in only for the client that started it"
package ai.eliza.plugins.signin;

public interface SecureSlot {
  String read() throws Exception;
  boolean compareExchange(String expected, String value) throws Exception;
}
