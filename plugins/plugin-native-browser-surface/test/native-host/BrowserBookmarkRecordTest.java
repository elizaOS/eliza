import ai.eliza.plugins.browsersurface.BrowserBookmarkRecord;
import ai.eliza.plugins.browsersurface.BrowserBookmarkRecord.Entry;
import ai.eliza.plugins.browsersurface.BrowserSessionPolicy;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;
import org.json.JSONArray;

/** Host-JVM check of the sealed bookmark record and its optional titles. Not Keystore or device evidence. */
public final class BrowserBookmarkRecordTest {
 private static int assertions;
 private static final Predicate<String> VALID = BrowserSessionPolicy::validBookmark;
 private static void check(boolean value,String message){assertions++;if(!value)throw new AssertionError(message);}
 private static void equal(Object actual,Object expected,String message){assertions++;if(!expected.equals(actual))throw new AssertionError(message+": "+actual);}
 /** Same JSON record; key order and escaping are the JSON library's. */
 private static void sameRecord(String actual,String expected,String message){assertions++;if(!new JSONArray(actual).similar(new JSONArray(expected)))throw new AssertionError(message+": "+actual);}
 private static void refused(String json,String message){
  assertions++;
  try{BrowserBookmarkRecord.read(json,VALID);}catch(Exception damaged){return;}
  throw new AssertionError("damaged record accepted: "+message);
 }
 private interface Change{void run();}
 private static void throwsOn(Class<? extends Exception> kind,Change change,String message){
  assertions++;
  try{change.run();}catch(Exception thrown){if(kind.isInstance(thrown))return;throw new AssertionError(message+": "+thrown);}
  throw new AssertionError(message);
 }
 public static void main(String[] args)throws Exception {
  // A record written by an earlier build reads back with no titles, and is rewritten unchanged.
  String old="[\"https://b.test/x?q=1\",\"https://a.test/\"]";
  List<Entry> rows=BrowserBookmarkRecord.read(old,VALID);
  equal(rows,List.of(new Entry("https://b.test/x?q=1",null),new Entry("https://a.test/",null)),"old record reads without titles");
  sameRecord(BrowserBookmarkRecord.write(rows),old,"a record without titles keeps the old format");
  check(BrowserBookmarkRecord.read(null,VALID).isEmpty(),"no record is no bookmarks");
  check(BrowserBookmarkRecord.read("[]",VALID).isEmpty(),"an empty record is no bookmarks");
  // Callers that pass no title behave as before.
  List<Entry> plain=BrowserBookmarkRecord.change(rows,"https://a.test/",true,null,VALID);
  sameRecord(BrowserBookmarkRecord.write(plain),"[\"https://a.test/\",\"https://b.test/x?q=1\"]","re-saving moves the address first, once");
  sameRecord(BrowserBookmarkRecord.write(BrowserBookmarkRecord.change(plain,"https://a.test/",false,null,VALID)),"[\"https://b.test/x?q=1\"]","removal");
  // The address list remains readable by previous builds.
  List<Entry> titled=BrowserBookmarkRecord.change(plain,"https://c.test/",true,"  Garden\tjournal\n",VALID);
  equal(titled.get(0),new Entry("https://c.test/","Garden journal"),"title is cleaned of control characters and trimmed");
  String written=BrowserBookmarkRecord.write(titled);
  sameRecord(written, "[\"https://c.test/\",\"https://a.test/\",\"https://b.test/x?q=1\"]",
      "the address list remains strings even when a bookmark has a title");
  String mixed = "[{\"url\":\"https://c.test/\",\"title\":\"Garden journal\"},\"https://a.test/\",\"https://b.test/x?q=1\"]";
  equal(BrowserBookmarkRecord.read(mixed, VALID), titled, "the earlier title format keeps order and titles");
  // No title keeps the saved title; a new title replaces it; a blank title removes it.
  List<Entry> kept=BrowserBookmarkRecord.change(BrowserBookmarkRecord.change(titled,"https://a.test/",true,null,VALID),"https://c.test/",true,null,VALID);
  equal(kept.get(0),new Entry("https://c.test/","Garden journal"),"re-saving without a title keeps it");
  equal(BrowserBookmarkRecord.change(kept,"https://c.test/",true,"Notes",VALID).get(0).title,"Notes","a new title replaces it");
  check(BrowserBookmarkRecord.change(kept,"https://c.test/",true," \u0007 ",VALID).get(0).title==null,"a blank title removes it");
  List<Entry> removed=BrowserBookmarkRecord.change(kept,"https://c.test/",false,"ignored",VALID);
  check(removed.stream().noneMatch(e->e.url.equals("https://c.test/")),"removal ignores the title");
  check(BrowserBookmarkRecord.change(removed,"https://c.test/",true,null,VALID).get(0).title==null,"a removed bookmark forgets its title");
  // Titles are bounded without splitting a surrogate pair.
  StringBuilder longTitle=new StringBuilder();
  for(int i=0;i<BrowserBookmarkRecord.MAX_TITLE-1;i++)longTitle.append('a');
  longTitle.append("😀tail");
  String bounded=BrowserBookmarkRecord.title(longTitle.toString());
  equal(bounded.length(),BrowserBookmarkRecord.MAX_TITLE-1,"surrogate pair at the bound is dropped whole");
  check(!Character.isHighSurrogate(bounded.charAt(bounded.length()-1)),"no lone surrogate");
  StringBuilder huge=new StringBuilder();
  for(int i=0;i<10000;i++)huge.append('z');
  equal(BrowserBookmarkRecord.title(huge.toString()).length(),BrowserBookmarkRecord.MAX_TITLE,"title bound");
  check(BrowserBookmarkRecord.title(null)==null&&BrowserBookmarkRecord.title("   ")==null,"null and blank are no title");
  // Damaged records are refused as a whole.
  refused("not json","not json");
  refused("{}","not a list");
  refused("[\"http://a.test/\"]","http address");
  refused("[\"https://a.test/\",\"https://a.test/\"]","repeated address");
  refused("[\"https://a.test/\",{\"url\":\"https://a.test/\",\"title\":\"A\"}]","repeated address with a title");
  refused("[null]","null row");
  refused("[7]","number row");
  refused("[{\"title\":\"A\"}]","titled row without an address");
  refused("[{\"url\":\"https://a.test/\"}]","object row without a title");
  refused("[{\"url\":\"https://a.test/\",\"title\":\"\"}]","empty stored title");
  refused("[{\"url\":\"https://a.test/\",\"title\":\" A\"}]","untrimmed stored title");
  refused("[{\"url\":\"https://a.test/\",\"title\":\"A\\u0000B\"}]","control character in a stored title");
  refused("[{\"url\":\"https://a.test/\",\"title\":7}]","non-text stored title");
  StringBuilder tooLong=new StringBuilder();
  for(int i=0;i<=BrowserBookmarkRecord.MAX_TITLE;i++)tooLong.append('t');
  refused("[{\"url\":\"https://a.test/\",\"title\":\""+tooLong+"\"}]","over-long stored title");
  // The 100-bookmark bound is unchanged.
  JSONArray hundred=new JSONArray();
  for(int i=0;i<BrowserBookmarkRecord.MAX;i++)hundred.put(i%2==0?"https://b"+i+".test/":new org.json.JSONObject().put("url","https://b"+i+".test/").put("title","B "+i));
  List<Entry> full=BrowserBookmarkRecord.read(hundred.toString(),VALID);
  equal(full.size(),BrowserBookmarkRecord.MAX,"a full record reads");
  throwsOn(IllegalStateException.class,()->BrowserBookmarkRecord.change(full,"https://new.test/",true,"New",VALID),"bookmark limit");
  equal(BrowserBookmarkRecord.change(full,"https://b5.test/",true,null,VALID).get(0),new Entry("https://b5.test/","B 5"),"re-saving at the limit keeps the title");
  hundred.put("https://extra.test/");
  refused(hundred.toString(),"over-long record");
  throwsOn(IllegalArgumentException.class,()->BrowserBookmarkRecord.change(new ArrayList<>(),"http://a.test/",true,"A",VALID),"invalid address refused");
  System.out.println(assertions + " assertions passed");
 }
}
