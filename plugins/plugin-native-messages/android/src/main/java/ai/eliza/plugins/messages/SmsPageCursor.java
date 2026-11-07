package ai.eliza.plugins.messages;

/** Stable descending date/kind/row key. Equal timestamps never disappear between pages. */
public final class SmsPageCursor {
 final long date, id; final String kind;
 SmsPageCursor(long date, String kind, long id) { this.date=date; this.kind=kind; this.id=id; }
 public static SmsPageCursor parse(String value, boolean thread) {
  if (value == null) return null;
  if (!value.matches("[0-9]{1,16}:(thread|sms|mms):[1-9][0-9]{0,17}")) throw new IllegalArgumentException("Invalid page cursor");
  String[] p=value.split(":"); SmsPageCursor c=new SmsPageCursor(Long.parseLong(p[0]),p[1],Long.parseLong(p[2]));
  if (thread != c.kind.equals("thread")) throw new IllegalArgumentException("Wrong cursor type"); return c;
 }
 static int compare(long aDate,String aKind,long aId,long bDate,String bKind,long bId) {
  int date=Long.compare(bDate,aDate); if(date!=0)return date;
  int kind=aKind.compareTo(bKind); if(kind!=0)return kind; return Long.compare(bId,aId);
 }
 boolean admits(long rowDate,String rowKind,long rowId) { return compare(rowDate,rowKind,rowId,date,kind,id)>0; }
 public String toString(){return date+":"+kind+":"+id;}
 /** Date predicate includes all tie rows; ID narrows only the same kind. Values are parsed integers. */
 String predicate(String rowKind, String dateColumn, String idColumn) {
  long units=rowKind.equals("mms")?1000:1, d=date/units;
  if(date%units!=0)return dateColumn+" <= "+d;
  int order=rowKind.compareTo(kind);
  if(order<0)return dateColumn+" < "+d;
  if(order>0)return dateColumn+" <= "+d;
  return "("+dateColumn+" < "+d+" OR ("+dateColumn+" = "+d+" AND "+idColumn+" < "+id+"))";
 }
}
