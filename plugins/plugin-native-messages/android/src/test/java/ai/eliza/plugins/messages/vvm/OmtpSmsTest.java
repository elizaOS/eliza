package ai.eliza.plugins.messages.vvm;

import java.util.HashMap;
import java.util.Map;
import org.junit.Test;

/** The OMTP SMS dialect: STATUS and SYNC parsing with malformed input, dates, the return-code mapping and the request texts. */
public final class OmtpSmsTest {
 static void require(boolean yes, String what) { if (!yes) throw new AssertionError(what); }
 static String malformed(String body) {
  try {
   OmtpSms.Message message = OmtpSms.parse(body, "//VVM");
   if (message == null) throw new AssertionError("not OMTP at all: " + body);
   if (OmtpSms.STATUS.equals(message.kind)) OmtpSms.status(message); else OmtpSms.sync(message);
  } catch (OmtpSms.Malformed malformed) { return malformed.getMessage(); }
  throw new AssertionError("accepted: " + body);
 }

 @Test public void statusCarriesTheImapAccount() throws Exception {
  OmtpSms.Status status = OmtpSms.status(OmtpSms.parse("//VVM:STATUS:st=R;rc=0;srv=vvm.carrier.example;tui=123;dn=999;ipt=143;spt=25;u=5550100@carrier.example;pw=c2VjcmV0PT0=;lang=eng;g_len=25;vs_len=15;pw_len=4-6;imap=993", "//VVM"));
  require(status.provisioning == 'R' && status.returnCode == 0 && status.ready(), "ready");
  require(status.server.equals("vvm.carrier.example") && status.imapPort == 993, "server and the imap port (not ipt)");
  require(status.user.equals("5550100@carrier.example") && status.password.equals("c2VjcmV0PT0="), "a base64 password keeps its = signs");
  OmtpSms.Status fresh = OmtpSms.status(OmtpSms.parse("//VVM:STATUS:st=N;srv=10.1.2.3;imap=143;u=u;pw=p;", "//VVM"));
  require(fresh.ready() && fresh.returnCode == 0, "a new subscriber without rc is ready; a trailing ; is fine");
  OmtpSms.Status pending = OmtpSms.status(OmtpSms.parse("//VVM:STATUS:st=P;rc=0", "//VVM"));
  require(!pending.ready() && pending.server == null && pending.password == null, "pending carries no account");
  require(OmtpSms.status(OmtpSms.parse("//XYZ:STATUS:st=U;rc=5", "//XYZ")).returnCode == 5, "a carrier's own client prefix");
 }

 @Test public void syncCarriesTheEvent() throws Exception {
  OmtpSms.Sync sync = OmtpSms.sync(OmtpSms.parse("//VVM:SYNC:ev=NM;id=3446456;c=1;t=v;s=01234567898;dt=02/08/2008 12:53 +0200;l=30", "//VVM"));
  require(sync.event.equals("NM") && sync.uid == 3446456 && sync.count == 1 && sync.type.equals("v") && sync.sender.equals("01234567898") && sync.seconds == 30, "fields");
  require(sync.date == 1217674380000L, "02/08/2008 12:53 +0200 is 2008-08-02T10:53Z");
  OmtpSms.Sync update = OmtpSms.sync(OmtpSms.parse("//VVM:SYNC:ev=MBU;c=0", "//VVM"));
  require(update.event.equals("MBU") && update.uid == -1 && update.date == -1 && update.seconds == -1 && update.sender == null, "absent fields");
  require(OmtpSms.sync(OmtpSms.parse("//VVM:SYNC:ev=GU", "//VVM")).event.equals("GU"), "greeting update");
 }

 @Test public void whatIsNotOmtpIsNullAndWhatIsBrokenIsRefused() throws Exception {
  require(OmtpSms.parse("You have 1 new voicemail", "//VVM") == null && OmtpSms.parse(null, "//VVM") == null && OmtpSms.parse("//VVMSTATUS:st=R", "//VVM") == null, "other text is not OMTP");
  require(OmtpSms.parse("//VVM:STATUS:st=R", "") == null, "no prefix, no message");
  malformed("//VVM:STATUS");
  malformed("//VVM::st=R");
  malformed("//VVM:OTHER:st=R");
  malformed("//VVM:STATUS:st=R;st=N;rc=0");
  malformed("//VVM:STATUS:=R");
  malformed("//VVM:STATUS:novalue");
  malformed("//VVM:STATUS:rc=0");
  malformed("//VVM:STATUS:st=X;rc=0");
  malformed("//VVM:STATUS:st=RR");
  malformed("//VVM:STATUS:st=R;rc=-1");
  malformed("//VVM:STATUS:st=R;rc=zero");
  malformed("//VVM:STATUS:st=U;rc=0;srv=bad host");
  malformed("//VVM:STATUS:st=U;rc=0;srv=host/path");
  malformed("//VVM:STATUS:st=U;imap=0");
  malformed("//VVM:STATUS:st=U;imap=70000");
  malformed("//VVM:STATUS:st=U;imap=99999999999999999999");
  malformed("//VVM:STATUS:st=U;pw=");
  malformed("//VVM:STATUS:st=U;u=");
  malformed("//VVM:STATUS:st=U;pw=a\rb");
  malformed("//VVM:STATUS:st=R;rc=0;srv=host;imap=143;u=u");
  malformed("//VVM:STATUS:st=R;rc=0");
  malformed("//VVM:SYNC:id=5");
  malformed("//VVM:SYNC:ev=XX");
  malformed("//VVM:SYNC:ev=NM;id=abc");
  malformed("//VVM:SYNC:ev=NM;dt=2008-08-02");
  malformed("//VVM:SYNC:ev=NM;dt=32/13/2008 12:53 +0200");
  malformed("//VVM:SYNC:ev=NM;l=long");
  StringBuilder many = new StringBuilder("//VVM:SYNC:ev=NM");
  for (int i = 0; i < 40; i++) many.append(";k").append((char) ('a' + i % 26)).append((char) ('a' + i / 26)).append("=1");
  malformed(many.toString());
  StringBuilder big = new StringBuilder("//VVM:SYNC:ev=NM;s=");
  for (int i = 0; i < 300; i++) big.append('1');
  malformed(big.toString());
  StringBuilder huge = new StringBuilder("//VVM:SYNC:ev=NM");
  for (int i = 0; i < 200; i++) huge.append(";s=12345");
  malformed(huge.toString());
  String secret = malformed("//VVM:STATUS:st=R;rc=0;srv=h;imap=143;u=u;pw=hunter2;pw=hunter2");
  require(!secret.contains("hunter2"), "a refusal never repeats the message");
  try { OmtpSms.status(OmtpSms.parse("//VVM:SYNC:ev=NM", "//VVM")); throw new AssertionError("a SYNC is not a STATUS"); } catch (OmtpSms.Malformed expected) { /* refused */ }
 }

 @Test public void platformParsedFieldsAreHeldToTheSameRules() throws Exception {
  Map<String, String> fields = new HashMap<>();
  fields.put("st", "R"); fields.put("rc", "0"); fields.put("srv", "h.example"); fields.put("imap", "143"); fields.put("u", "u"); fields.put("pw", "p");
  require(OmtpSms.status(new OmtpSms.Message("STATUS", fields)).ready(), "fields as the platform hands them");
  fields.put("bad key", "1");
  try { new OmtpSms.Message("STATUS", fields); throw new AssertionError("bad field name accepted"); } catch (OmtpSms.Malformed expected) { /* refused */ }
  try { new OmtpSms.Message("GREETING", new HashMap<>()); throw new AssertionError("unknown kind accepted"); } catch (OmtpSms.Malformed expected) { /* refused */ }
 }

 @Test public void datesAreStrict() {
  require(OmtpSms.date("02/08/2008 12:53 +0200") == 1217674380000L && OmtpSms.date("01/01/2026 00:00 +0000") == 1767225600000L, "valid");
  for (String bad : new String[] { null, "", "02/08/2008", "02/08/2008 12:53", "2008/08/02 12:53 +0200", "02/08/2008 25:00 +0200", "02/08/2008 12:53 +0200 extra", "30/02/2008 12:53 +0200" })
   require(OmtpSms.date(bad) == -1, "refused: " + bad);
 }

 static OmtpSms.Channels channels(String body) throws Exception { return OmtpSms.channels(OmtpSms.status(OmtpSms.parse(body, "//VVM"))); }
 static boolean is(OmtpSms.Channels channels, int configuration, int data, int notification) { return channels.configuration == configuration && channels.data == data && channels.notification == notification; }

 @Test public void returnCodesAndStatesReduceToChannelStates() throws Exception {
  String account = ";srv=h;imap=143;u=u;pw=p";
  require(is(channels("//VVM:STATUS:st=R;rc=0" + account), OmtpSms.CONFIG_OK, OmtpSms.DATA_OK, OmtpSms.NOTIFICATION_OK), "ready");
  require(is(channels("//VVM:STATUS:st=N;rc=0" + account), OmtpSms.CONFIG_OK, OmtpSms.DATA_OK, OmtpSms.NOTIFICATION_OK), "new subscriber");
  require(is(channels("//VVM:STATUS:st=P;rc=0"), OmtpSms.CONFIG_CONFIGURING, OmtpSms.DATA_OK, OmtpSms.NOTIFICATION_OK), "pending");
  require(is(channels("//VVM:STATUS:st=U;rc=0"), OmtpSms.CONFIG_FAILED, OmtpSms.DATA_OK, OmtpSms.NOTIFICATION_OK), "unknown subscriber");
  require(is(channels("//VVM:STATUS:st=B;rc=0"), OmtpSms.CONFIG_FAILED, OmtpSms.DATA_OK, OmtpSms.NOTIFICATION_OK), "blocked");
  require(is(channels("//VVM:STATUS:st=R;rc=1" + account), OmtpSms.CONFIG_FAILED, OmtpSms.DATA_SERVER_ERROR, OmtpSms.NOTIFICATION_OK), "system error is never ready");
  for (int rc : new int[] { 2, 3, 6, 9, 42 })
   require(is(channels("//VVM:STATUS:st=U;rc=" + rc), OmtpSms.CONFIG_FAILED, OmtpSms.DATA_BAD_CONFIGURATION, OmtpSms.NOTIFICATION_OK), "rc " + rc);
  for (int rc : new int[] { 4, 5 })
   require(is(channels("//VVM:STATUS:st=U;rc=" + rc), OmtpSms.CONFIG_NOT_CONFIGURED, OmtpSms.DATA_OK, OmtpSms.NOTIFICATION_OK), "rc " + rc);
  require(is(channels("//VVM:STATUS:st=U;rc=7"), OmtpSms.CONFIG_CAN_BE_CONFIGURED, OmtpSms.DATA_OK, OmtpSms.NOTIFICATION_OK), "mailbox not initialised");
 }

 @Test public void requestsFollowTheVersionAndVariant() {
  require(OmtpSms.request("Activate", false, OmtpSms.V1_1, null, 0, "//VVM").equals("Activate"), "1.1");
  require(OmtpSms.request("STATUS", false, OmtpSms.V1_2, "acme.vvm.1", 0, "//VVM").equals("STATUS:pv=12;ct=acme.vvm.1"), "1.2");
  require(OmtpSms.request("Activate", false, OmtpSms.V1_3, "acme.vvm.1", 5499, "//VVM").equals("Activate:pv=13;ct=acme.vvm.1;pt=5499;//VVM"), "1.3");
  require(OmtpSms.request("Activate", true, OmtpSms.V1_3, "acme.vvm.1", 5499, "//VVM").equals("Activate:dt=6"), "CVVM");
  for (String[] bad : new String[][] { { "14", "acme" }, { OmtpSms.V1_2, null }, { OmtpSms.V1_3, "a;b" } })
   try { OmtpSms.request("Activate", false, bad[0], bad[1], 0, "//VVM"); throw new AssertionError("accepted"); } catch (IllegalArgumentException expected) { /* refused */ }
 }
}
