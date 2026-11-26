// spec/os/signIn/cloudRequests.md, "The agent reaches the broker only by a bodiless GET on the loopback host, without an origin, with the current launch's bearer"; spec/os/signIn/cloudRequests.md, "The broker forwards only the owner's Gmail account list and search, with the lease, while the launch's owner holds it"; spec/os/signIn/cloudRequests.md, "The agent gets the cloud's status and body, or a refusal naming why nothing was read, and never the credential that read it"
package ai.eliza.plugins.signin;

import ai.eliza.os.agent.RouteGate.Method;
import ai.eliza.plugins.signin.CloudRequestPolicy.CallPlan;
import ai.eliza.plugins.signin.CloudRequestPolicy.DeviceRoute;
import ai.eliza.plugins.signin.CloudRequestPolicy.Holding;
import ai.eliza.plugins.signin.CloudRequestPolicy.Refusal;
import ai.eliza.plugins.signin.CloudRequestPolicy.Refuse;
import java.util.List;
import java.util.Map;

public final class GoogleBrokerPolicy {
  private GoogleBrokerPolicy() {}

  public record Ask(boolean get, boolean bodiless, boolean loopbackHost, boolean origin, boolean bearer) {}

  public enum AskVerdict { ASK_ADMITTED, NOT_PRIVATE, NOT_AUTHORIZED }

  public enum Read { ACCOUNT_LIST, MAIL_SEARCH, NOT_BROKERED }

  public record Call(Read read, List<String> fields, boolean ownerHolds) {
    public Call { fields = List.copyOf(fields); }
  }

  public sealed interface Outcome permits CloudAnswered, CallRefused, CloudUnreachable, ReplyOversize {}
  public record CloudAnswered(int status) implements Outcome {}
  public record CallRefused(Refusal why) implements Outcome {}
  public record CloudUnreachable() implements Outcome {}
  public record ReplyOversize() implements Outcome {}

  public enum BrokerRefusal {
    BROKER_NOT_FORWARDED("not-brokered"), BROKER_SIGN_IN_REQUIRED("sign-in-required"), BROKER_LEASE_UPGRADE_REQUIRED("mail-lease-upgrade-required"),
    BROKER_UNREACHABLE("cloud-unreachable"), BROKER_REPLY_TOO_LARGE("reply-too-large");

    public final String wire;

    BrokerRefusal(String wire) { this.wire = wire; }
  }

  public sealed interface Reply permits Answer, Refused {}
  public record Answer(int status) implements Reply {}
  public record Refused(int status, BrokerRefusal reason) implements Reply {}

  private static final String GOOGLE = "/api/v1/eliza/google/";
  private static final Map<Read, List<String>> PARTS = Map.of(
    Read.ACCOUNT_LIST, List.of("api", "v1", "eliza", "google", "accounts"),
    Read.MAIL_SEARCH, List.of("api", "v1", "eliza", "google", "gmail", "search"),
    Read.NOT_BROKERED, List.of());
  private static final Map<Read, List<String>> FIELDS = Map.of(
    Read.ACCOUNT_LIST, List.of("side"),
    Read.MAIL_SEARCH, List.of("side", "grantId", "query", "maxResults", "pageToken"),
    Read.NOT_BROKERED, List.of());

  public static AskVerdict askVerdict(Ask ask) {
    if (!ask.get() || !ask.bodiless() || !ask.loopbackHost() || ask.origin()) return AskVerdict.NOT_PRIVATE;
    if (!ask.bearer()) return AskVerdict.NOT_AUTHORIZED;
    return AskVerdict.ASK_ADMITTED;
  }

  public static Read readOf(String path) {
    for (Read read : List.of(Read.ACCOUNT_LIST, Read.MAIL_SEARCH))
      if (path.equals("/" + String.join("/", PARTS.get(read)))) return read;
    return Read.NOT_BROKERED;
  }

  static List<String> queriesFor(String route) {
    Read read = route == null || !route.startsWith(GOOGLE) ? Read.NOT_BROKERED : readOf(route);
    return read == Read.NOT_BROKERED ? null : FIELDS.get(read);
  }

  public static boolean brokered(Call call) {
    return call.read() != Read.NOT_BROKERED && FIELDS.get(call.read()).containsAll(call.fields());
  }

  public static Refusal refusalOf(Call call) {
    if (!brokered(call)) return Refusal.NOT_LISTED;
    if (!call.ownerHolds()) return Refusal.SIGN_IN_REQUIRED;
    return null;
  }

  public static CallPlan brokerPlan(Holding h, Call call) {
    Refusal refused = refusalOf(call);
    if (refused != null) return new Refuse(refused);
    for (DeviceRoute d : CloudRequestPolicy.DEVICE_ROUTES)
      if (d.method() == Method.GET && d.path().equals(PARTS.get(call.read()))) return CloudRequestPolicy.attachFor(h, d);
    return new Refuse(Refusal.NOT_LISTED);
  }

  public static Reply replyOf(Outcome outcome) {
    return switch (outcome) {
      case CloudAnswered answered -> new Answer(answered.status());
      case CallRefused refused -> switch (refused.why()) {
        case NOT_LISTED -> new Refused(404, BrokerRefusal.BROKER_NOT_FORWARDED);
        case SIGN_IN_REQUIRED -> new Refused(403, BrokerRefusal.BROKER_SIGN_IN_REQUIRED);
        case MAIL_LEASE_UPGRADE_REQUIRED -> new Refused(403, BrokerRefusal.BROKER_LEASE_UPGRADE_REQUIRED);
        case NO_ORIGIN, BODY_TOO_LARGE, HEADER_REFUSED, REAUTH_REQUIRED -> new Refused(503, BrokerRefusal.BROKER_UNREACHABLE);
      };
      case CloudUnreachable unreachable -> new Refused(503, BrokerRefusal.BROKER_UNREACHABLE);
      case ReplyOversize oversize -> new Refused(502, BrokerRefusal.BROKER_REPLY_TOO_LARGE);
    };
  }

  public static Outcome outcomeOf(CloudRequests.Outcome sent) {
    return switch (sent) {
      case CloudRequests.Answered answered when answered.body() != null && answered.grant() == null -> new CloudAnswered(answered.status());
      case CloudRequests.Answered answered -> new ReplyOversize();
      case CloudRequests.Failed failed -> switch (failed.failure()) {
        case NOT_LISTED -> new CallRefused(Refusal.NOT_LISTED);
        case SIGN_IN_REQUIRED -> new CallRefused(Refusal.SIGN_IN_REQUIRED);
        case MAIL_LEASE_UPGRADE_REQUIRED -> new CallRefused(Refusal.MAIL_LEASE_UPGRADE_REQUIRED);
        case NO_ORIGIN -> new CallRefused(Refusal.NO_ORIGIN);
        case BODY_TOO_LARGE -> new CallRefused(Refusal.BODY_TOO_LARGE);
        case HEADER_REFUSED -> new CallRefused(Refusal.HEADER_REFUSED);
        case REAUTH_REQUIRED -> new CallRefused(Refusal.REAUTH_REQUIRED);
        case REPLY_TOO_LARGE -> new ReplyOversize();
        case NETWORK, NAME_IN_USE, CANCELLED -> new CloudUnreachable();
      };
    };
  }
}
