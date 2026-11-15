package ai.eliza.plugins.messages.vvm;

import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The OMTP visual-voicemail SMS dialect as pure functions: the carrier's STATUS and SYNC messages
 * ({@code //VVM:STATUS:st=R;rc=0;srv=...} and {@code //VVM:SYNC:ev=NM;id=...}), the client's
 * Activate / Status requests, and the reduction of a STATUS answer to the three
 * {@code VoicemailContract.Status} channel states.
 *
 * Parsing is strict and bounded. A message with the wrong prefix is not OMTP ({@code null}); one
 * that is OMTP but breaks a rule is {@link Malformed}, and nothing is taken from it. No value from a
 * message is ever put in an exception text, so a refused message cannot leak a password into a log.
 */
public final class OmtpSms {
 private OmtpSms() {}
 public static final int MAX_BODY = 1024, MAX_FIELDS = 32, MAX_VALUE = 256;
 public static final String STATUS = "STATUS", SYNC = "SYNC", DEFAULT_PREFIX = "//VVM";
 /** Protocol versions as the {@code pv} field spells them. */
 public static final String V1_1 = "11", V1_2 = "12", V1_3 = "13";
 // VoicemailContract.Status values (compile-time constants there; repeated so this class has no Android dependency).
 static final int CONFIG_OK = 0, CONFIG_NOT_CONFIGURED = 1, CONFIG_CAN_BE_CONFIGURED = 2, CONFIG_CONFIGURING = 3, CONFIG_FAILED = 4, CONFIG_DISABLED = 5;
 static final int DATA_OK = 0, DATA_NO_CONNECTION = 1, DATA_NO_CONNECTION_CELLULAR_REQUIRED = 2, DATA_BAD_CONFIGURATION = 3, DATA_COMMUNICATION_ERROR = 4,
   DATA_SERVER_ERROR = 5, DATA_SERVER_CONNECTION_ERROR = 6;
 static final int NOTIFICATION_OK = 0, NOTIFICATION_NO_CONNECTION = 1;

 private static final Pattern KEY = Pattern.compile("[A-Za-z_]{1,16}");
 private static final Pattern WORD = Pattern.compile("[A-Za-z]{1,16}");
 private static final Pattern HOST = Pattern.compile("[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|[0-9A-Fa-f:]{2,45}");
 private static final Pattern NUMBER = Pattern.compile("[0-9]{1,9}");
 private static final Pattern UID = Pattern.compile("[0-9]{1,18}");

 /** An OMTP message that breaks the format. The text names the rule, never the message's content. */
 public static final class Malformed extends Exception {
  private static final long serialVersionUID = 1L;
  Malformed(String rule) { super(rule, null, false, false); }
 }

 /** One message: its kind ({@link #STATUS} or {@link #SYNC}) and its fields in message order. */
 public static final class Message {
  public final String kind; public final Map<String, String> fields;
  /** @throws Malformed when the kind or a field breaks the bounds {@link #parse} enforces. */
  public Message(String kind, Map<String, String> fields) throws Malformed {
   if (kind == null || fields == null) throw new Malformed("missing kind");
   String upper = kind.toUpperCase(Locale.ROOT);
   if (!STATUS.equals(upper) && !SYNC.equals(upper)) throw new Malformed("unknown kind");
   if (fields.size() > MAX_FIELDS) throw new Malformed("too many fields");
   Map<String, String> copy = new LinkedHashMap<>();
   for (Map.Entry<String, String> field : fields.entrySet()) {
    String key = field.getKey(), value = field.getValue();
    if (key == null || value == null || !KEY.matcher(key).matches()) throw new Malformed("bad field name");
    if (value.length() > MAX_VALUE || control(value)) throw new Malformed("bad field value");
    if (copy.put(key.toLowerCase(Locale.ROOT), value) != null) throw new Malformed("repeated field");
   }
   this.kind = upper; this.fields = Collections.unmodifiableMap(copy);
  }
 }

 /**
  * Reads {@code <clientPrefix>:<KIND>:key=value;key=value;...}. A value is everything after the first
  * {@code =} of its field, so base64 passwords survive. Returns null when the text does not start with
  * the client prefix (it is not a visual-voicemail message at all).
  */
  public static Message parse(String body, String clientPrefix) throws Malformed {
  if (body == null || clientPrefix == null || clientPrefix.isEmpty() || !body.startsWith(clientPrefix + ":")) return null;
  if (body.length() > MAX_BODY) throw new Malformed("message too long");
  String rest = body.substring(clientPrefix.length() + 1);
  int colon = rest.indexOf(':');
  if (colon < 0 || !WORD.matcher(rest.substring(0, colon)).matches()) throw new Malformed("missing kind");
  Map<String, String> fields = new LinkedHashMap<>();
  for (String part : rest.substring(colon + 1).split(";", -1)) {
   if (part.trim().isEmpty()) continue;
   int equals = part.indexOf('=');
   if (equals <= 0) throw new Malformed("field without a name");
   if (fields.put(part.substring(0, equals).trim().toLowerCase(Locale.ROOT), part.substring(equals + 1)) != null) throw new Malformed("repeated field");
   if (fields.size() > MAX_FIELDS) throw new Malformed("too many fields");
  }
  return new Message(rest.substring(0, colon), fields);
 }

 /** A STATUS answer. {@code server}, {@code user} and {@code password} are null unless the carrier sent them. */
 public static final class Status {
  /** N new subscriber, R ready, P provisioning pending, U unknown subscriber, B blocked. */
  public final char provisioning;
  /** The {@code rc} return code; 0 (success) when the carrier sent none. */
  public final int returnCode;
  public final String server, user, password;
  /** The IMAP port, or 0 when the carrier sent none. */
  public final int imapPort;
  Status(char provisioning, int returnCode, String server, int imapPort, String user, String password) {
   this.provisioning = provisioning; this.returnCode = returnCode; this.server = server; this.imapPort = imapPort; this.user = user; this.password = password;
  }
  /** The mailbox can be reached: the subscriber is provisioned, the request succeeded, and the IMAP account is complete. */
  public boolean ready() { return (provisioning == 'R' || provisioning == 'N') && returnCode == 0 && server != null && imapPort > 0 && user != null && password != null; }
 }

 public static Status status(Message message) throws Malformed {
  if (message == null || !STATUS.equals(message.kind)) throw new Malformed("not a status message");
  Map<String, String> f = message.fields;
  String st = f.get("st");
  if (st == null || st.length() != 1 || "NRPUB".indexOf(st.charAt(0)) < 0) throw new Malformed("unknown provisioning state");
  int rc = number(f.get("rc"), 0, 99, 0, "bad return code");
  String server = f.get("srv"), user = f.get("u"), password = f.get("pw");
  if (server != null && !HOST.matcher(server).matches()) throw new Malformed("bad server address");
  int port = number(f.get("imap"), 1, 65535, 0, "bad IMAP port");
  if (user != null && user.isEmpty()) throw new Malformed("empty user");
  if (password != null && password.isEmpty()) throw new Malformed("empty password");
  Status status = new Status(st.charAt(0), rc, server, port, user, password);
  if ((status.provisioning == 'R' || status.provisioning == 'N') && rc == 0 && !status.ready()) throw new Malformed("ready without a complete account");
  return status;
 }

 /** A SYNC notice. Only {@code event} is required; absent fields are -1 or null. */
 public static final class Sync {
  /** NM new message, MBU mailbox update, GU greeting update. */
  public final String event;
  /** The IMAP UID the notice is about, the mailbox's new-message count, the message length in seconds, its deposit time. */
  public final long uid, date; public final int count, seconds;
  /** {@code t}: v voice, o video, f fax, i infotainment, e empty call capture. {@code sender} is the caller's number. */
  public final String type, sender;
  Sync(String event, long uid, int count, String type, String sender, long date, int seconds) {
   this.event = event; this.uid = uid; this.count = count; this.type = type; this.sender = sender; this.date = date; this.seconds = seconds;
  }
 }

 public static Sync sync(Message message) throws Malformed {
  if (message == null || !SYNC.equals(message.kind)) throw new Malformed("not a sync message");
  Map<String, String> f = message.fields;
  String event = f.get("ev");
  if (event == null) throw new Malformed("missing event");
  event = event.toUpperCase(Locale.ROOT);
  if (!event.equals("NM") && !event.equals("MBU") && !event.equals("GU")) throw new Malformed("unknown event");
  String id = f.get("id"), dt = f.get("dt");
  if (id != null && !UID.matcher(id).matches()) throw new Malformed("bad message id");
  long date = -1;
  if (dt != null && (date = date(dt)) < 0) throw new Malformed("bad date");
  return new Sync(event, id == null ? -1 : Long.parseLong(id), number(f.get("c"), 0, 999_999, -1, "bad count"), f.get("t"), f.get("s"), date,
    number(f.get("l"), 0, 999_999, -1, "bad length"));
 }

 /** An OMTP date ({@code dd/MM/yyyy HH:mm Z}, e.g. {@code 02/08/2008 12:53 +0200}) as epoch milliseconds, or -1. */
 public static long date(String text) {
  if (text == null || text.length() > 32) return -1;
  SimpleDateFormat format = new SimpleDateFormat("dd/MM/yyyy HH:mm Z", Locale.US);
  format.setLenient(false);
  ParsePosition at = new ParsePosition(0);
  Date parsed = format.parse(text.trim(), at);
  return parsed == null || at.getIndex() != text.trim().length() || parsed.getTime() <= 0 ? -1 : parsed.getTime();
 }

 /** The three channel states one source reports in {@code VoicemailContract.Status}. */
 public static final class Channels {
  public final int configuration, data, notification;
  public Channels(int configuration, int data, int notification) { this.configuration = configuration; this.data = data; this.notification = notification; }
 }

 /**
  * What a STATUS answer says about the service. The notification channel is OK whenever an answer
  * arrived at all (it came over that channel). Return codes: 0 success, 1 system error, 2 subscriber
  * error, 3 mailbox unknown, 4 not activated, 5 not provisioned, 6 client unknown, 7 mailbox not
  * initialised. Anything else, and every state but ready, is reported as not working, never as ready.
  */
 public static Channels channels(Status status) {
  switch (status.returnCode) {
   case 0: break;
   case 1: return new Channels(CONFIG_FAILED, DATA_SERVER_ERROR, NOTIFICATION_OK);
   case 4: case 5: return new Channels(CONFIG_NOT_CONFIGURED, DATA_OK, NOTIFICATION_OK);
   case 7: return new Channels(CONFIG_CAN_BE_CONFIGURED, DATA_OK, NOTIFICATION_OK);
   default: return new Channels(CONFIG_FAILED, DATA_BAD_CONFIGURATION, NOTIFICATION_OK);
  }
  if (status.ready()) return new Channels(CONFIG_OK, DATA_OK, NOTIFICATION_OK);
  if (status.provisioning == 'P') return new Channels(CONFIG_CONFIGURING, DATA_OK, NOTIFICATION_OK);
  return new Channels(CONFIG_FAILED, DATA_OK, NOTIFICATION_OK);
 }

 /**
  * The client's request text. {@code verb} is {@code Activate}, {@code Deactivate} or {@code STATUS}.
  * OMTP 1.1 sends the bare verb; 1.2 adds the protocol version and client type; 1.3 also the
  * application port and client prefix. The CVVM variant sends {@code <verb>:dt=6} whatever the version.
  */
 public static String request(String verb, boolean cvvm, String version, String clientType, int applicationPort, String clientPrefix) {
  if (cvvm) return verb + ":dt=6";
  if (V1_1.equals(version)) return verb;
  if (!V1_2.equals(version) && !V1_3.equals(version)) throw new IllegalArgumentException("Unknown OMTP version");
  if (clientType == null || !clientType.matches("[A-Za-z0-9._-]{1,30}")) throw new IllegalArgumentException("OMTP 1.2+ needs a client type");
  String text = verb + ":pv=" + version + ";ct=" + clientType;
  return V1_3.equals(version) ? text + ";pt=" + applicationPort + ";" + clientPrefix : text;
 }

 private static int number(String text, int min, int max, int absent, String rule) throws Malformed {
  if (text == null) return absent;
  if (!NUMBER.matcher(text).matches()) throw new Malformed(rule);
  int value = Integer.parseInt(text);
  if (value < min || value > max) throw new Malformed(rule);
  return value;
 }
 private static boolean control(String value) {
  for (int i = 0; i < value.length(); i++) if (value.charAt(i) < 0x20 || value.charAt(i) == 0x7f) return true;
  return false;
 }
}
