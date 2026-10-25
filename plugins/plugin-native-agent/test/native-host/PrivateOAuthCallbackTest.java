package ai.eliza.plugins.agent.runtime.test;

import ai.eliza.plugins.agent.runtime.PrivateOAuthCallback;
import java.util.ArrayList;
import java.util.concurrent.RejectedExecutionException;

public final class PrivateOAuthCallbackTest {
  private static void check(boolean value) { if (!value) throw new AssertionError("callback contract failed"); }
  public static void main(String[] args) {
    var delivered = new ArrayList<String>();
    var queued = new ArrayList<Runnable>();
    int[] failures = {0};
    var callback = new PrivateOAuthCallback("https://product.example/link", queued::add, delivered::add, () -> failures[0]++);
    String valid = "https://product.example/link?state=synthetic&code=synthetic";
    check(callback.accept(valid) == PrivateOAuthCallback.Admission.QUEUED);
    check(delivered.isEmpty());
    queued.remove(0).run();
    check(delivered.size() == 1 && delivered.get(0).equals(valid));
    for (String wrong : new String[]{"https://attacker.example/link?code=x", "https://product.example/other?code=x", "http://product.example/link?code=x", "https://product.example:444/link?code=x", "https://product.example/l%69nk?code=x"})
      check(callback.accept(wrong) == PrivateOAuthCallback.Admission.NOT_MATCHED);
    for (String invalid : new String[]{"https://product.example/link", valid + "#fragment", "https://user@product.example/link?code=x", valid + "x".repeat(8192), "https://product.example/link?code=%ZZ"})
      check(callback.accept(invalid) == PrivateOAuthCallback.Admission.REJECTED);
    check(delivered.size() == 1 && queued.isEmpty());
    var failing = new PrivateOAuthCallback("https://product.example/link", Runnable::run, ignored -> { throw new Exception("untrusted secret must not escape"); }, () -> failures[0]++);
    check(failing.accept(valid) == PrivateOAuthCallback.Admission.QUEUED);
    check(failures[0] == 1);
    var busy = new PrivateOAuthCallback("https://product.example/link", task -> { throw new RejectedExecutionException(); }, delivered::add, () -> failures[0]++);
    check(busy.accept(valid) == PrivateOAuthCallback.Admission.BUSY);
    check(delivered.size() == 1);
    for (String invalid : new String[]{"http://product.example/link", "https://product.example/link?query", "https://product.example/link#fragment", "https://product.example/a/../link"}) {
      boolean rejected = false;
      try { new PrivateOAuthCallback(invalid, Runnable::run, delivered::add, () -> {}); }
      catch (IllegalArgumentException expected) { rejected = true; }
      check(rejected);
    }
    System.out.println("Private OAuth callback contract passed");
  }
}
