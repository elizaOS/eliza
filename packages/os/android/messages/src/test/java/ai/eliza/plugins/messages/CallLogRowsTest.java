package ai.eliza.plugins.messages;

import org.junit.Test;

/** JVM checks of the recent-calls row mapping shared with the contract's parseCallLog. */
public final class CallLogRowsTest {
 static void require(boolean yes, String what) { if (!yes) throw new AssertionError(what); }

 @Test public void typesNumbersAndBounds() {
  require(CallLogRows.type(1).equals("incoming"), "incoming");
  require(CallLogRows.type(2).equals("outgoing"), "outgoing");
  require(CallLogRows.type(3).equals("missed"), "missed");
  require(CallLogRows.type(7).equals("answered_externally"), "answered externally");
  require(CallLogRows.type(99).equals("unknown"), "unknown stays unknown, never a placed call");

  require(CallLogRows.number("+1 (555) 555-0100").equals("+15555550100"), "separators removed");
  require(CallLogRows.number("5550101").equals("5550101"), "local number");
  require(CallLogRows.number(null).isEmpty(), "withheld");
  require(CallLogRows.number("").isEmpty(), "empty");
  require(CallLogRows.number("-1").isEmpty(), "private-number marker");
  require(CallLogRows.number("*#06#").isEmpty(), "MMI is never dialable");
  require(CallLogRows.number("555,123").isEmpty(), "pause is never dialable");
  require(CallLogRows.number("1+555").isEmpty(), "inner plus");
  require(CallLogRows.number("+123456789012345678901").isEmpty(), "too long");

  require(CallLogRows.limit(1) == 1 && CallLogRows.limit(50) == 50, "bounds kept");
  require(CallLogRows.limit(0) == -1 && CallLogRows.limit(51) == -1 && CallLogRows.limit(null) == -1, "outside refused");

  require(CallLogRows.publishable("12", 1000, Long.MAX_VALUE), "first row");
  require(!CallLogRows.publishable("12", 2000, 1000), "newer than previous");
  require(!CallLogRows.publishable("x", 1000, Long.MAX_VALUE), "non-numeric id");
  require(!CallLogRows.publishable("12", 0, Long.MAX_VALUE), "no date");
  require(CallLogRows.duration(-5) == 0 && CallLogRows.duration(7) == 7, "duration");
 }
}
