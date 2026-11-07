package ai.eliza.plugins.messages;

import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The subset of the OMA MMS encapsulation (WAP-209 / OMA-MMS-ENC 1.3) that a default SMS app needs on
 * public Android APIs: parse M-Notification.ind and M-Retrieve.conf (headers and the multipart body),
 * and encode M-Send.req, M-NotifyResp.ind and M-Acknowledge.ind. Plain Java so the JVM tests cover it.
 *
 * Parsing is bounded and strict: a malformed or truncated PDU throws {@link IllegalArgumentException};
 * nothing is guessed. Unknown header fields are skipped by their encoded length.
 */
public final class MmsPdu {
 private MmsPdu() {}

 public static final int SEND_REQ = 0x80, SEND_CONF = 0x81, NOTIFICATION_IND = 0x82, NOTIFYRESP_IND = 0x83, RETRIEVE_CONF = 0x84, ACKNOWLEDGE_IND = 0x85;
 /** X-Mms-Response-Status of M-Send.conf: Ok. */
 public static final int RESPONSE_OK = 0x80;
 /** X-Mms-Status values of M-NotifyResp.ind. */
 public static final int STATUS_RETRIEVED = 0x81, STATUS_DEFERRED = 0x83, STATUS_UNRECOGNISED = 0x84;
 public static final int VERSION_1_2 = 0x12;
 static final int MAX_PDU = 2 * 1024 * 1024, MAX_PARTS = 32, MAX_ADDRESSES = 20;

 // Header field codes (without the 0x80 short-integer bit).
 static final int BCC = 0x01, CC = 0x02, CONTENT_LOCATION = 0x03, CONTENT_TYPE = 0x04, DATE = 0x05, DELIVERY_REPORT = 0x06, EXPIRY = 0x08, FROM = 0x09,
  MESSAGE_CLASS = 0x0A, MESSAGE_ID = 0x0B, MESSAGE_TYPE = 0x0C, MMS_VERSION = 0x0D, MESSAGE_SIZE = 0x0E, PRIORITY = 0x0F, READ_REPORT = 0x10,
  REPORT_ALLOWED = 0x11, RESPONSE_STATUS = 0x12, RESPONSE_TEXT = 0x13, SENDER_VISIBILITY = 0x14, STATUS = 0x15, SUBJECT = 0x16, TO = 0x17,
  TRANSACTION_ID = 0x18, RETRIEVE_STATUS = 0x19, RETRIEVE_TEXT = 0x1A, READ_STATUS = 0x1B;
 static final int ADDRESS_PRESENT = 0x80, INSERT_ADDRESS = 0x81;
 static final int MIB_UTF8 = 106;

 /** One body part. Text parts carry their decoded text as well as their bytes. */
 public static final class Part {
  public final String contentType, charset, name, contentId, location;
  public final byte[] data;
  public Part(String contentType, String charset, String name, String contentId, String location, byte[] data) {
   this.contentType = contentType; this.charset = charset; this.name = name; this.contentId = contentId; this.location = location; this.data = data;
  }
  public static Part text(String text, String location) { return new Part("text/plain", "utf-8", null, "<" + location + ">", location, text.getBytes(StandardCharsets.UTF_8)); }
  public boolean isText() { return "text/plain".equalsIgnoreCase(contentType); }
  public String text() { return new String(data, charsetFor(charset)); }
 }

 /** A parsed PDU. Unset numbers are -1; unset strings null. */
 public static final class Message {
  public int type = -1, version = -1, messageClass = -1, retrieveStatus = -1, responseStatus = -1;
  public String transactionId, messageId, from, subject, contentLocation, contentType, start;
  public long date = -1, size = -1, expiry = -1;
  public final List<String> to = new ArrayList<>(), cc = new ArrayList<>(), bcc = new ArrayList<>();
  public final List<Part> parts = new ArrayList<>();
 }

 // ---- Parsing ---------------------------------------------------------------------------------

 private static final class Reader {
  final byte[] b; int i; final int end;
  Reader(byte[] b, int start, int end) { this.b = b; this.i = start; this.end = end; }
  boolean more() { return i < end; }
  int peek() { need(1); return b[i] & 0xff; }
  int u8() { need(1); return b[i++] & 0xff; }
  // Compared as a remainder: a declared length near Integer.MAX_VALUE must not wrap i + n past the check.
  void need(int n) { if (n < 0 || n > end - i) throw new IllegalArgumentException("Truncated MMS PDU"); }
  byte[] bytes(int n) { need(n); byte[] out = java.util.Arrays.copyOfRange(b, i, i + n); i += n; return out; }
  long uintvar() {
   long value = 0;
   for (int k = 0; k < 5; k++) { int c = u8(); value = (value << 7) | (c & 0x7f); if ((c & 0x80) == 0) return value; }
   throw new IllegalArgumentException("Invalid MMS uintvar");
  }
  /** Value-length: Short-length (0..30) or Length-quote (31) followed by a uintvar. */
  int valueLength() {
   int c = u8();
   if (c < 31) return c;
   if (c == 31) { long n = uintvar(); if (n > Integer.MAX_VALUE) throw new IllegalArgumentException("Invalid MMS length"); return (int) n; }
   throw new IllegalArgumentException("Expected an MMS value length");
  }
  String textString() {
   int start = i;
   if (peek() == 0x7f) start = ++i; // Quote before a text starting at 0x80 or above.
   while (u8() != 0) { }
   return new String(b, start, i - 1 - start, StandardCharsets.ISO_8859_1);
  }
  long integer() {
   int c = peek();
   if (c >= 0x80) { i++; return c & 0x7f; }
   int n = u8();
   if (n > 8) throw new IllegalArgumentException("Invalid MMS long integer");
   long value = 0; for (int k = 0; k < n; k++) value = (value << 8) | u8();
   return value;
  }
  /** Encoded-string-value: Text-string, or Value-length Char-set Text-string. */
  String encodedString() {
   int c = peek();
   if (c < 31 || c == 31) {
    int length = valueLength(), stop = i + length; need(length);
    int mib = (int) integer();
    // A value-length shorter than its own charset must not let the text run backwards.
    if (i > stop) throw new IllegalArgumentException("Invalid MMS encoded string");
    int start = i; if (i < stop && (b[i] & 0xff) == 0x7f) start = ++i;
    int text = stop; for (int k = start; k < stop; k++) if (b[k] == 0) { text = k; break; }
    String value = new String(b, start, text - start, charsetFor(mib));
    i = stop; return value;
   }
   byte[] raw; int start = i;
   if (c == 0x7f) start = ++i;
   while (u8() != 0) { }
   raw = java.util.Arrays.copyOfRange(b, start, i - 1);
   return new String(raw, StandardCharsets.UTF_8);
  }
  /** Skips one header value whose type is not interpreted. */
  void skipValue() {
   int c = peek();
   if (c >= 0x80) { i++; return; }
   if (c <= 31) { int length = valueLength(); need(length); i += length; return; }
   textString();
  }
 }

 public static Message parse(byte[] pdu) {
  if (pdu == null || pdu.length < 3 || pdu.length > MAX_PDU) throw new IllegalArgumentException("Invalid MMS PDU size");
  Reader r = new Reader(pdu, 0, pdu.length);
  Message m = new Message();
  boolean typed = false;
  while (r.more()) {
   int field = r.u8();
   if ((field & 0x80) == 0) { // An application header: Token-text then a text value.
    r.i--; r.textString(); r.textString(); continue;
   }
   field &= 0x7f;
   if (!typed && field != MESSAGE_TYPE) throw new IllegalArgumentException("MMS PDU must start with its message type");
   switch (field) {
    case MESSAGE_TYPE: if (typed) throw new IllegalArgumentException("Repeated MMS message type"); m.type = r.u8(); typed = true; break;
    case TRANSACTION_ID: m.transactionId = r.textString(); break;
    case MMS_VERSION: m.version = (int) r.integer(); break;
    case MESSAGE_ID: m.messageId = r.textString(); break;
    case CONTENT_LOCATION: m.contentLocation = r.textString(); break;
    case DATE: m.date = r.integer(); break;
    case MESSAGE_SIZE: m.size = r.integer(); break;
    case SUBJECT: m.subject = r.encodedString(); break;
    case TO: case CC: case BCC: {
     String address = address(r.encodedString());
     List<String> list = field == TO ? m.to : field == CC ? m.cc : m.bcc;
     if (m.to.size() + m.cc.size() + m.bcc.size() >= MAX_ADDRESSES) throw new IllegalArgumentException("Too many MMS addresses");
     list.add(address); break;
    }
    case FROM: {
     int length = r.valueLength(), stop = r.i + length; r.need(length);
     int token = r.u8();
     if (token == ADDRESS_PRESENT) m.from = address(r.encodedString());
     else if (token != INSERT_ADDRESS) throw new IllegalArgumentException("Invalid MMS From");
     if (r.i != stop) throw new IllegalArgumentException("Invalid MMS From length");
     break;
    }
    case EXPIRY: {
     int length = r.valueLength(), stop = r.i + length; r.need(length);
     int token = r.u8(); long value = r.integer();
     m.expiry = token == 0x80 ? value : -value; // Absolute seconds, or negative for a relative delta.
     if (r.i != stop) throw new IllegalArgumentException("Invalid MMS expiry");
     break;
    }
    case MESSAGE_CLASS: { int c = r.peek(); if (c >= 0x80) m.messageClass = r.u8(); else r.textString(); break; }
    case RETRIEVE_STATUS: m.retrieveStatus = r.u8(); break;
    case RESPONSE_STATUS: m.responseStatus = r.u8(); break;
    case CONTENT_TYPE: {
     String[] type = contentType(r);
     m.contentType = type[0]; m.start = type[2];
     if (m.contentType.startsWith("application/vnd.wap.multipart.")) multipart(r, m.parts);
     else if (r.more()) m.parts.add(new Part(m.contentType, type[1], null, null, null, r.bytes(r.end - r.i)));
     return m; // The body follows Content-Type, which is the last header.
    }
    default: r.skipValue();
   }
  }
  if (!typed) throw new IllegalArgumentException("MMS PDU has no message type");
  return m;
 }

 /** Strips the "/TYPE=PLMN" or "/TYPE=IPv4" suffix of an MMS address. */
 static String address(String raw) {
  if (raw == null) return null;
  int slash = raw.indexOf("/TYPE=");
  String value = slash >= 0 ? raw.substring(0, slash) : raw;
  if (value.isEmpty() || value.length() > 256) throw new IllegalArgumentException("Invalid MMS address");
  return value;
 }

 /** Content-type value: returns {media type, charset name or null, start or null, name or null}. Consumes exactly the value. */
 private static String[] contentType(Reader r) {
  int c = r.peek();
  if (c >= 0x80) { r.i++; return new String[] { wellKnownType(c & 0x7f), null, null, null }; }
  if (c > 31) return new String[] { r.textString().toLowerCase(java.util.Locale.ROOT), null, null, null };
  int length = r.valueLength(), stop = r.i + length; r.need(length);
  Reader v = new Reader(r.b, r.i, stop);
  int first = v.peek();
  String media;
  if (first >= 0x80) { v.i++; media = wellKnownType(first & 0x7f); }
  else if (first > 31) media = v.textString().toLowerCase(java.util.Locale.ROOT);
  else { media = wellKnownType((int) v.integer()); }
  String charset = null, start = null, name = null;
  while (v.more()) {
   int p = v.peek();
   if (p >= 0x80) {
    v.i++;
    switch (p & 0x7f) {
     case 0x01: charset = charsetName((int) v.integer()); break; // Charset
     case 0x0A: case 0x19: start = v.textString(); break;        // Start (1.2 / 1.4)
     case 0x05: case 0x17: name = v.textString(); break;          // Name (1.1 / 1.4)
     default: v.skipValue();
    }
   } else { v.textString(); v.skipValue(); } // Untyped parameter: token then value.
  }
  r.i = stop;
  return new String[] { media, charset, start, name };
 }

 private static void multipart(Reader r, List<Part> parts) {
  long count = r.uintvar();
  if (count > MAX_PARTS) throw new IllegalArgumentException("Too many MMS parts");
  for (int n = 0; n < count; n++) {
   long headersLength = r.uintvar(), dataLength = r.uintvar();
   if (headersLength > r.end - r.i || dataLength > r.end - r.i) throw new IllegalArgumentException("Truncated MMS part");
   int headersEnd = r.i + (int) headersLength;
   Reader h = new Reader(r.b, r.i, headersEnd);
   String[] type = contentType(h);
   String contentId = null, location = null, name = type[3];
   while (h.more()) {
    int field = h.peek();
    if (field >= 0x80) {
     h.i++;
     switch (field & 0x7f) {
      case 0x40: contentId = h.peek() == 0x22 ? quoted(h) : h.textString(); break; // Content-ID
      case 0x0E: location = h.textString(); break;                              // Content-Location
      case 0x2E: { int length = h.valueLength(); h.need(length); h.i += length; break; } // Content-Disposition
      default: h.skipValue();
     }
    } else { String header = h.textString(); String value = h.textString(); if ("content-id".equalsIgnoreCase(header)) contentId = value; }
   }
   r.i = headersEnd;
   byte[] data = r.bytes((int) dataLength);
   parts.add(new Part(type[0], type[1], name, contentId, location, data));
  }
 }
 private static String quoted(Reader r) { r.u8(); return r.textString(); }

 private static String wellKnownType(int code) {
  switch (code) {
   case 0x03: return "text/plain";
   case 0x1D: return "image/gif";
   case 0x1E: return "image/jpeg";
   case 0x20: return "image/png";
   case 0x21: return "image/vnd.wap.wbmp";
   case 0x23: return "application/vnd.wap.multipart.mixed";
   case 0x26: return "application/vnd.wap.multipart.alternative";
   case 0x33: return "application/vnd.wap.multipart.related";
   case 0x3E: return "application/vnd.wap.mms-message";
   default: return "application/octet-stream";
  }
 }
 private static int wellKnownCode(String type) {
  switch (type) {
   case "text/plain": return 0x03;
   case "image/gif": return 0x1D;
   case "image/jpeg": return 0x1E;
   case "image/png": return 0x20;
   case "application/vnd.wap.multipart.related": return 0x33;
   case "application/vnd.wap.multipart.mixed": return 0x23;
   default: return -1;
  }
 }
 static String charsetName(int mib) {
  switch (mib) {
   case 3: return "us-ascii";
   case 4: return "iso-8859-1";
   case 106: return "utf-8";
   case 1000: return "utf-16";
   case 1013: return "utf-16be";
   case 1014: return "utf-16le";
   case 1015: return "utf-16";
   default: return null;
  }
 }
 static Charset charsetFor(int mib) { return charsetFor(charsetName(mib)); }
 static Charset charsetFor(String name) {
  try { return name == null ? StandardCharsets.UTF_8 : Charset.forName(name); } catch (RuntimeException unknown) { return StandardCharsets.UTF_8; }
 }

 // ---- Encoding --------------------------------------------------------------------------------

 private static final class Writer {
  final ByteArrayOutputStream out = new ByteArrayOutputStream();
  Writer u8(int v) { out.write(v & 0xff); return this; }
  Writer field(int code) { return u8(0x80 | code); }
  Writer bytes(byte[] v) { out.write(v, 0, v.length); return this; }
  Writer text(String v) {
   byte[] raw = v.getBytes(StandardCharsets.UTF_8);
   if (raw.length > 0 && (raw[0] & 0xff) >= 0x80) u8(0x7f);
   return bytes(raw).u8(0);
  }
  Writer uintvar(long v) {
   int shift = 0; long rest = v >>> 7; while (rest != 0) { shift += 7; rest >>>= 7; }
   for (; shift > 0; shift -= 7) u8((int) (((v >>> shift) & 0x7f) | 0x80));
   return u8((int) (v & 0x7f));
  }
  Writer valueLength(int n) { if (n < 31) return u8(n); return u8(31).uintvar(n); }
  /** Encoded-string-value with the UTF-8 charset when the text is not plain ASCII. */
  Writer encoded(String v) {
   boolean ascii = v.chars().allMatch(c -> c >= 0x20 && c < 0x7f);
   if (ascii) return text(v);
   Writer value = new Writer(); value.u8(0x80 | MIB_UTF8 /* short-integer form fits 106 */); value.text(v);
   byte[] raw = value.out.toByteArray();
   return valueLength(raw.length).bytes(raw);
  }
  byte[] done() { return out.toByteArray(); }
 }

 /** One address field value: a phone number becomes {@code number/TYPE=PLMN}. */
 private static String encodedAddress(String number) { return number.contains("@") ? number : number + "/TYPE=PLMN"; }

 /**
  * M-Send.req with From insert-address-token, the recipients as To, an optional subject, and a
  * multipart/related body whose SMIL lists the parts in order. Text parts are UTF-8.
  */
 public static byte[] encodeSendRequest(String transactionId, List<String> to, String subject, List<Part> parts) {
  if (transactionId == null || !transactionId.matches("[A-Za-z0-9._-]{1,64}") || to == null || to.isEmpty() || to.size() > MAX_ADDRESSES || parts == null || parts.isEmpty() || parts.size() >= MAX_PARTS)
   throw new IllegalArgumentException("Invalid MMS send request");
  Writer w = new Writer();
  w.field(MESSAGE_TYPE).u8(SEND_REQ);
  w.field(TRANSACTION_ID).text(transactionId);
  w.field(MMS_VERSION).u8(0x80 | VERSION_1_2);
  w.field(FROM).u8(1).u8(INSERT_ADDRESS);
  for (String number : to) w.field(TO).encoded(encodedAddress(number));
  if (subject != null && !subject.isEmpty()) w.field(SUBJECT).encoded(subject);
  w.field(MESSAGE_CLASS).u8(0x80); // Personal
  w.field(DELIVERY_REPORT).u8(0x81); // No: MMS delivery is never claimed.
  w.field(READ_REPORT).u8(0x81);
  List<Part> body = new ArrayList<>();
  body.add(new Part("application/smil", "utf-8", null, "<smil>", "smil.xml", smil(parts).getBytes(StandardCharsets.UTF_8)));
  body.addAll(parts);
  // Content-Type: multipart/related; type="application/smil"; start="<smil>".
  Writer type = new Writer();
  type.u8(0x80 | wellKnownCode("application/vnd.wap.multipart.related"));
  type.u8(0x80 | 0x09).text("application/smil");
  type.u8(0x80 | 0x0A).text("<smil>");
  byte[] typeValue = type.done();
  w.field(CONTENT_TYPE).valueLength(typeValue.length).bytes(typeValue);
  w.uintvar(body.size());
  for (Part part : body) {
   Writer headers = new Writer();
   Writer partType = new Writer();
   int code = wellKnownCode(part.contentType);
   if (code >= 0) partType.u8(0x80 | code); else partType.text(part.contentType);
   if (part.charset != null) partType.u8(0x80 | 0x01).u8(0x80 | MIB_UTF8);
   if (part.name != null) partType.u8(0x80 | 0x05).text(part.name);
   byte[] partTypeValue = partType.done();
   headers.valueLength(partTypeValue.length).bytes(partTypeValue);
   if (part.contentId != null) headers.u8(0x80 | 0x40).u8(0x22).text(part.contentId);
   if (part.location != null) headers.u8(0x80 | 0x0E).text(part.location);
   byte[] h = headers.done();
   w.uintvar(h.length).uintvar(part.data.length).bytes(h).bytes(part.data);
  }
  return w.done();
 }
 private static String smil(List<Part> parts) {
  StringBuilder s = new StringBuilder("<smil><head><layout><root-layout/><region id=\"Image\" top=\"0\" left=\"0\" height=\"80%\" width=\"100%\"/><region id=\"Text\" top=\"80%\" left=\"0\" height=\"20%\" width=\"100%\"/></layout></head><body>");
  for (Part part : parts) {
   String ref = part.location == null ? "part" : part.location.replace("\"", "");
   s.append("<par dur=\"5000ms\">");
   if (part.isText()) s.append("<text src=\"").append(ref).append("\" region=\"Text\"/>");
   else if (part.contentType.startsWith("image/")) s.append("<img src=\"").append(ref).append("\" region=\"Image\"/>");
   else s.append("<ref src=\"").append(ref).append("\"/>");
   s.append("</par>");
  }
  return s.append("</body></smil>").toString();
 }

 /** M-NotifyResp.ind for a notification's transaction: retrieved, deferred or unrecognised. */
 public static byte[] encodeNotifyResponse(String transactionId, int status) {
  if (transactionId == null || transactionId.isEmpty() || (status != STATUS_RETRIEVED && status != STATUS_DEFERRED && status != STATUS_UNRECOGNISED)) throw new IllegalArgumentException("Invalid MMS notify response");
  Writer w = new Writer();
  w.field(MESSAGE_TYPE).u8(NOTIFYRESP_IND).field(TRANSACTION_ID).text(transactionId).field(MMS_VERSION).u8(0x80 | VERSION_1_2).field(STATUS).u8(status).field(REPORT_ALLOWED).u8(0x81);
  return w.done();
 }

 /** M-Acknowledge.ind after a deferred retrieval. */
 public static byte[] encodeAcknowledge(String transactionId) {
  if (transactionId == null || transactionId.isEmpty()) throw new IllegalArgumentException("Invalid MMS acknowledge");
  Writer w = new Writer();
  w.field(MESSAGE_TYPE).u8(ACKNOWLEDGE_IND).field(TRANSACTION_ID).text(transactionId).field(MMS_VERSION).u8(0x80 | VERSION_1_2).field(REPORT_ALLOWED).u8(0x81);
  return w.done();
 }

 /** Text of every text/plain part in order, joined by newlines. */
 public static String text(Message message) {
  List<String> texts = new ArrayList<>();
  for (Part part : message.parts) if (part.isText()) texts.add(part.text());
  return String.join("\n", texts);
 }
 /** Parts other than text and SMIL presentation. */
 public static List<Part> attachments(Message message) {
  List<Part> out = new ArrayList<>();
  for (Part part : message.parts) if (!part.isText() && !"application/smil".equalsIgnoreCase(part.contentType)) out.add(part);
  return Collections.unmodifiableList(out);
 }
}
