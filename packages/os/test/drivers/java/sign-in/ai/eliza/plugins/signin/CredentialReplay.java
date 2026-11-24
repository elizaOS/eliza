// spec/os/signIn/credential.md, "Story: Keep me signed in without a second copy of my key"; spec/os/signIn/credential.md, "Story: Sign out or reset cleanly"; spec/os/signIn/credential.md, "Story: Confirm it is me before a billing change"
package ai.eliza.plugins.signin;

import ai.eliza.plugins.signin.CredentialPolicy.Account;
import ai.eliza.plugins.signin.CredentialPolicy.LeaseOffer;
import ai.eliza.plugins.signin.CredentialPolicy.LeaseUse;
import ai.eliza.plugins.signin.CredentialPolicy.Notice;
import ai.eliza.plugins.signin.CredentialPolicy.Reason;
import ai.eliza.plugins.signin.CredentialPolicy.RefreshAnswer;
import ai.eliza.plugins.signin.CredentialPolicy.RejectedOn;
import ai.eliza.plugins.signin.DeviceCredentialStore.Kept;
import ai.eliza.plugins.signin.DeviceCredentialStore.LeaseSecret;
import ai.eliza.plugins.signin.DeviceCredentialStore.Outcome;
import ai.eliza.plugins.signin.DeviceCredentialStore.SessionRead;
import ai.eliza.plugins.signin.DeviceCredentialStore.Token;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class CredentialReplay {
  private static final String AUTHORITY = DeviceCredentialStore.authorityDigest("https://cloud.test");

  private enum KeyWrite { WRITE, LOSE, UNREADABLE }

  private static final class MemorySlots implements DeviceCredentialStore.Slots {
    final Map<String, String> held = new HashMap<>();
    KeyWrite next = KeyWrite.WRITE;

    private static boolean key(String slot) { return slot.contains(":key:") || slot.contains(":lease:"); }

    @Override public String read(String slot) throws IOException {
      if (key(slot) && next == KeyWrite.UNREADABLE) throw new IOException("unreadable");
      return held.get(slot);
    }

    @Override public void write(String slot, String value) throws IOException {
      if (key(slot) && next == KeyWrite.LOSE) {
        held.remove(slot);
        throw new IOException("lost");
      }
      held.put(slot, value);
    }

    @Override public void remove(String slot) { held.remove(slot); }
  }

  private MemorySlots slots;
  private long now;
  private DeviceCredentialStore store;
  private final List<Notice> out = new ArrayList<>();

  private void open() {
    store = new DeviceCredentialStore(slots, AUTHORITY, () -> now);
    store.listen(out::add);
    store.onVerifyAccount(() -> out.add(new Notice.VerifyAccount()));
    store.onRenewKey(() -> out.add(new Notice.RenewKey()));
  }

  private void reset() {
    slots = new MemorySlots();
    now = 0;
    open();
  }

  private static KeyWrite keyWrite(String stored) {
    return switch (stored) {
      case "Written" -> KeyWrite.WRITE;
      case "Unconfirmed" -> KeyWrite.UNREADABLE;
      case "Removed", "Conflict", "CapacityRefused", "Refused", "Failed" -> KeyWrite.LOSE;
      default -> throw new CredentialJson.Malformed("stored " + stored);
    };
  }

  private static RejectedOn on(String on) {
    return switch (on) {
      case "AccountRead" -> RejectedOn.ACCOUNT_READ;
      case "OtherRequest" -> RejectedOn.OTHER_REQUEST;
      default -> throw new CredentialJson.Malformed("on " + on);
    };
  }

  private static RefreshAnswer refreshAnswer(Map<String, Object> answer) {
    return switch (CredentialJson.text(answer, "tag")) {
      case "Refreshed" -> new RefreshAnswer.Refreshed(CredentialJson.whole(answer, "accessExpiresAt"));
      case "RefreshUnanswered" -> new RefreshAnswer.Unanswered();
      case "RefreshRefused" -> new RefreshAnswer.Refused();
      default -> throw new CredentialJson.Malformed("refresh answer");
    };
  }

  private static LeaseUse presented(String presented) {
    return switch (presented) {
      case "RefreshUse" -> LeaseUse.REFRESH_USE;
      case "AccessUse" -> LeaseUse.ACCESS_USE;
      default -> throw new CredentialJson.Malformed("presented " + presented);
    };
  }

  private static String secret(String prefix, int length, long seed) {
    String digits = Long.toString(seed, 36);
    return prefix + "x".repeat(length - digits.length()) + digits;
  }

  private static boolean settled(String reply) {
    return switch (reply) {
      case "RevokeSettled" -> true;
      case "RevokeUnanswered" -> false;
      default -> throw new CredentialJson.Malformed("reply " + reply);
    };
  }

  private boolean apply(Map<String, Object> e) {
    String type = CredentialJson.text(e, "type");
    return switch (type) {
      case "beginSignIn" -> { store.beginSignIn(); yield true; }
      case "tokenAnswered" -> {
        LeaseOffer offer = CredentialPolicy.offer(e.get("lease"));
        if (offer instanceof LeaseOffer.Renewal) yield false;
        slots.next = keyWrite(CredentialJson.text(e, "stored"));
        try {
          Account account = CredentialPolicy.account(e.get("account"));
          String credentialId = CredentialJson.text(e, "credentialId");
          LeaseSecret lease = offer instanceof LeaseOffer.Offered o ? new LeaseSecret(secret("eliza_lease_refresh_", 54, now), o.refreshExpiresAt()) : null;
          yield store.tokenAnswered(CredentialJson.small(e, "attempt"),
            new Token(credentialId, "key-" + credentialId + "-" + account.userId(), account, CredentialJson.whole(e, "keyExpiresAt"), lease)) != Kept.REFUSED;
        } finally {
          slots.next = KeyWrite.WRITE;
        }
      }
      case "beginRenewal" -> store.beginRenewal() != null;
      case "readLease" -> {
        SessionRead read = store.readLease().stage();
        if (read == SessionRead.START_REFRESH) out.add(new Notice.RefreshLease());
        yield read == SessionRead.START_REFRESH || read == SessionRead.AWAIT_REFRESH;
      }
      case "leaseRefreshAnswered" -> {
        Map<String, Object> rotation = CredentialJson.object(e.get("rotation"), "rotation");
        int version = CredentialJson.small(e, "version");
        yield switch (CredentialJson.text(rotation, "tag")) {
          case "LeaseUnanswered" -> store.leaseUnanswered(version) == Outcome.ACCEPTED;
          case "LeaseRotated" -> {
            slots.next = keyWrite(CredentialJson.text(rotation, "stored"));
            try {
              yield store.leaseRotated(version, secret("eliza_lease_refresh_", 54, now + 1),
                CredentialJson.whole(rotation, "accessExpiresAt"), CredentialJson.whole(rotation, "refreshExpiresAt")) != Kept.REFUSED;
            } finally {
              slots.next = KeyWrite.WRITE;
            }
          }
          default -> throw new CredentialJson.Malformed("rotation");
        };
      }
      case "leaseRejected" -> store.leaseRejected(CredentialJson.small(e, "version"), Reason.ofTag(CredentialJson.text(e, "reason")),
        presented(CredentialJson.text(e, "presented"))) == Outcome.ACCEPTED;
      case "acknowledged" -> store.acknowledged(CredentialJson.small(e, "attempt"), CredentialJson.text(e, "credentialId"),
        CredentialJson.whole(e, "keyExpiresAt")) == Outcome.ACCEPTED;
      case "signInEnded" -> store.signInEnded(CredentialJson.small(e, "attempt")) == Outcome.ACCEPTED;
      case "rejected" -> store.rejected(CredentialJson.small(e, "version"), Reason.ofTag(CredentialJson.text(e, "reason")),
        on(CredentialJson.text(e, "on"))) == Outcome.ACCEPTED;
      case "signOut" -> { store.signOut(); yield true; }
      case "reset" -> { store.reset(); yield true; }
      case "revokeAnswered" -> store.revokeAnswered(CredentialJson.small(e, "version"), settled(CredentialJson.text(e, "reply"))) == Outcome.ACCEPTED;
      case "elapse" -> {
        long ms = CredentialJson.whole(e, "ms");
        if (ms <= 0) yield false;
        now += ms;
        store.state();
        yield true;
      }
      case "restart" -> { open(); yield true; }
      case "dropSession" -> store.dropSession() == Outcome.ACCEPTED;
      case "grantSession" -> store.grantSession(CredentialPolicy.account(e.get("account")), CredentialJson.whole(e, "accessExpiresAt"));
      case "refreshAnswered" -> store.refreshAnswered(refreshAnswer(CredentialJson.object(e.get("answer"), "answer"))) == Outcome.ACCEPTED;
      case "readSession" -> {
        SessionRead read = store.readSession();
        if (read == SessionRead.START_REFRESH) out.add(new Notice.RefreshAccountSession());
        yield read == SessionRead.START_REFRESH || read == SessionRead.AWAIT_REFRESH;
      }
      default -> throw new CredentialJson.Malformed("event " + type);
    };
  }

  private String state() {
    StringBuilder notices = new StringBuilder("[");
    for (Notice notice : out) {
      if (notices.length() > 1) notices.append(',');
      notices.append(CredentialPolicy.json(notice));
    }
    return "{\"state\":" + CredentialPolicy.json(store.state()) + ",\"out\":" + notices.append(']');
  }

  private String answer(String line) {
    Map<String, Object> request = CredentialJson.object(CredentialJson.parse(line), "request");
    out.clear();
    if (!request.containsKey("event")) {
      reset();
      return state() + "}";
    }
    boolean accepted = apply(CredentialJson.object(request.get("event"), "event"));
    if (!CredentialPolicy.holds(store.state())) throw new IllegalStateException("the credential rules broke after " + line);
    return state() + ",\"outcome\":\"" + (accepted ? "accepted" : "refused") + "\"}";
  }

  public static void main(String[] args) throws Exception {
    CredentialReplay replay = new CredentialReplay();
    PrintStream printer = new PrintStream(System.out, true, StandardCharsets.UTF_8);
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    for (String line = in.readLine(); line != null; line = in.readLine()) {
      try {
        printer.println(replay.answer(line));
      } catch (RuntimeException broken) {
        printer.println("{\"error\":" + CredentialJson.quote(String.valueOf(broken.getMessage())) + "}");
      }
    }
  }
}
