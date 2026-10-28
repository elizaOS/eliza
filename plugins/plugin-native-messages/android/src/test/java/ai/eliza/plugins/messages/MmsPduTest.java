package ai.eliza.plugins.messages;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

/** Encoding and parsing of the MMS PDUs a default SMS app exchanges. No radio or MMSC. */
public final class MmsPduTest {
 private static byte[] concat(byte[]... chunks) {
  ByteArrayOutputStream out = new ByteArrayOutputStream();
  for (byte[] chunk : chunks) out.write(chunk, 0, chunk.length);
  return out.toByteArray();
 }
 private static byte[] text(String value) { return concat(value.getBytes(StandardCharsets.ISO_8859_1), new byte[] { 0 }); }
 private static byte[] b(int... values) { byte[] out = new byte[values.length]; for (int i = 0; i < values.length; i++) out[i] = (byte) values[i]; return out; }

 /** An M-Notification.ind as a carrier sends it in WAP push. */
 static byte[] notification() {
  return concat(
   b(0x8C, 0x82),                       // Message-Type notification-ind
   b(0x98), text("T1234"),              // Transaction-Id
   b(0x8D, 0x92),                       // MMS-Version 1.2
   b(0x89, 0x0E, 0x80), text("+15555550100/TYPE=PLMN"), // From, address present (length 14? replaced below)
   b(0x8A, 0x80),                       // Message-Class personal
   b(0x8E, 0x02, 0x10, 0x00),           // Message-Size 4096
   b(0x88, 0x05, 0x81, 0x03, 0x02, 0xA3, 0x00), // Expiry: relative 172800 seconds
   b(0x83), text("http://mmsc.example/m/abc")); // Content-Location
 }

 @Test public void parsesNotificationHeaders() {
  byte[] pdu = notification();
  // Fix the From value length to the real encoded size: token + text.
  int fromAt = 2 + 1 + 6 + 2;
  pdu[fromAt + 1] = (byte) (1 + "+15555550100/TYPE=PLMN".length() + 1);
  MmsPdu.Message m = MmsPdu.parse(pdu);
  assertEquals(MmsPdu.NOTIFICATION_IND, m.type);
  assertEquals("T1234", m.transactionId);
  assertEquals(0x12, m.version);
  assertEquals("+15555550100", m.from);
  assertEquals(4096, m.size);
  assertEquals(-172800, m.expiry);
  assertEquals("http://mmsc.example/m/abc", m.contentLocation);
  assertTrue(m.parts.isEmpty());
 }

 @Test public void sendRequestRoundTripsThroughTheParser() {
  byte[] image = new byte[700];
  for (int i = 0; i < image.length; i++) image[i] = (byte) i;
  List<MmsPdu.Part> parts = Arrays.asList(
   MmsPdu.Part.text("Hello é😀", "text_0.txt"),
   new MmsPdu.Part("image/jpeg", null, "photo.jpg", "<image_0>", "image_0.jpg", image));
  byte[] pdu = MmsPdu.encodeSendRequest("op-42", Arrays.asList("+15555550100", "5550101"), "Plans ✓", parts);
  assertEquals(0x8C, pdu[0] & 0xff);
  assertEquals(MmsPdu.SEND_REQ, pdu[1] & 0xff);
  MmsPdu.Message m = MmsPdu.parse(pdu);
  assertEquals(MmsPdu.SEND_REQ, m.type);
  assertEquals("op-42", m.transactionId);
  assertNull("From is the insert-address token", m.from);
  assertEquals(Arrays.asList("+15555550100", "5550101"), m.to);
  assertEquals("Plans ✓", m.subject);
  assertEquals("application/vnd.wap.multipart.related", m.contentType);
  assertEquals("<smil>", m.start);
  assertEquals(3, m.parts.size());
  assertEquals("application/smil", m.parts.get(0).contentType);
  assertTrue(new String(m.parts.get(0).data, StandardCharsets.UTF_8).contains("<img src=\"image_0.jpg\""));
  assertEquals("Hello é😀", MmsPdu.text(m));
  MmsPdu.Part photo = MmsPdu.attachments(m).get(0);
  assertEquals("image/jpeg", photo.contentType);
  assertEquals("photo.jpg", photo.name);
  assertEquals("<image_0>", photo.contentId);
  assertEquals("image_0.jpg", photo.location);
  assertArrayEquals(image, photo.data);
 }

 @Test public void parsesRetrieveConfWithSenderAndCharsets() {
  // Build an M-Retrieve.conf from a send request: swap the type and insert a sender and a date.
  byte[] send = MmsPdu.encodeSendRequest("tx-9", Arrays.asList("+15555550101"), null, Arrays.asList(MmsPdu.Part.text("Picked up", "t.txt")));
  int afterVersion = 2 + 1 + "tx-9".length() + 1 + 2; // type, transaction id, version
  int fromEnd = afterVersion + 3; // From: length 1, insert-address token
  byte[] from = concat(b(0x89, 1 + "+15555550100/TYPE=PLMN".length() + 1, 0x80), text("+15555550100/TYPE=PLMN"));
  byte[] date = b(0x85, 0x04, 0x65, 0x53, 0xF1, 0x00);
  byte[] pdu = concat(Arrays.copyOfRange(send, 0, afterVersion), date, from, Arrays.copyOfRange(send, fromEnd, send.length));
  pdu[1] = (byte) MmsPdu.RETRIEVE_CONF;
  MmsPdu.Message m = MmsPdu.parse(pdu);
  assertEquals(MmsPdu.RETRIEVE_CONF, m.type);
  assertEquals("+15555550100", m.from);
  assertEquals(Arrays.asList("+15555550101"), m.to);
  assertEquals(0x6553F100L, m.date);
  assertEquals("Picked up", MmsPdu.text(m));
  assertTrue(MmsPdu.attachments(m).isEmpty());
 }

 @Test public void responsesAreMinimalAndTyped() {
  MmsPdu.Message notify = MmsPdu.parse(MmsPdu.encodeNotifyResponse("T1234", MmsPdu.STATUS_RETRIEVED));
  assertEquals(MmsPdu.NOTIFYRESP_IND, notify.type);
  assertEquals("T1234", notify.transactionId);
  MmsPdu.Message ack = MmsPdu.parse(MmsPdu.encodeAcknowledge("T1234"));
  assertEquals(MmsPdu.ACKNOWLEDGE_IND, ack.type);
  assertThrows(IllegalArgumentException.class, () -> MmsPdu.encodeNotifyResponse("T1234", 0x99));
 }

 @Test public void malformedPdusAreRefusedNotGuessed() {
  assertThrows(IllegalArgumentException.class, () -> MmsPdu.parse(new byte[] { (byte) 0x98, 0x41, 0x00 }));
  byte[] truncated = Arrays.copyOf(notification(), 7);
  assertThrows(IllegalArgumentException.class, () -> MmsPdu.parse(truncated));
  byte[] send = MmsPdu.encodeSendRequest("op-1", Arrays.asList("+15555550100"), null, Arrays.asList(MmsPdu.Part.text("x", "t.txt")));
  assertThrows(IllegalArgumentException.class, () -> MmsPdu.parse(Arrays.copyOf(send, send.length - 1)));
  assertThrows(IllegalArgumentException.class, () -> MmsPdu.encodeSendRequest("op 1", Arrays.asList("+15555550100"), null, Arrays.asList(MmsPdu.Part.text("x", "t.txt"))));
 }

 @Test public void declaredLengthsBeyondThePduAreRefusedWithoutWrapping() {
  // Value-length Integer.MAX_VALUE (Length-quote, uintvar 87 FF FF FF 7F): the bound check must not overflow.
  byte[] huge = b(0x1F, 0x87, 0xFF, 0xFF, 0xFF, 0x7F, 0xEA, 'a', 0x00);
  assertThrows(IllegalArgumentException.class, () -> MmsPdu.parse(concat(b(0x8C, 0x84, 0x96), huge))); // Subject
  assertThrows(IllegalArgumentException.class, () -> MmsPdu.parse(concat(b(0x8C, 0x84, 0x97), huge))); // To
  assertThrows(IllegalArgumentException.class, () -> MmsPdu.parse(concat(b(0x8C, 0x84, 0xB0), huge))); // Unknown header, skipped by length
  assertThrows(IllegalArgumentException.class, () -> MmsPdu.parse(concat(b(0x8C, 0x84, 0x89), huge))); // From
 }
}
