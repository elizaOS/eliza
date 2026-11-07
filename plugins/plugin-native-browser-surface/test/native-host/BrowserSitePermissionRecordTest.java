import ai.eliza.plugins.browsersurface.BrowserSitePermissionRecord;
import ai.eliza.plugins.browsersurface.BrowserSitePermissions;
import java.util.List;
import org.json.JSONObject;

/** Host-JVM check of the sealed site-permission record read through upstream rules. Not WebView or Keystore evidence. */
public final class BrowserSitePermissionRecordTest {
 private static int assertions;
 private static void check(boolean value,String message){assertions++;if(!value)throw new AssertionError(message);}
 private static void empty(BrowserSitePermissions p,String message){
  check(p.origins().isEmpty()&&p.decision("https://a.example/","camera",false)==null,message);
 }
 public static void main(String[] args)throws Exception {
  // A record written by an earlier build: allow and deny are read as they are.
  BrowserSitePermissions old=BrowserSitePermissionRecord.read("{\"https://a.example\":{\"camera\":true,\"microphone\":false},\"http://b.example:8080\":{\"location\":true}}");
  check(Boolean.TRUE.equals(old.decision("https://a.example/page","camera",false)),"stored Allow is read");
  check(Boolean.FALSE.equals(old.decision("https://a.example/","microphone",false)),"stored Deny is read");
  check(old.decision("https://a.example/","location",false)==null,"an undecided kind asks");
  check(Boolean.TRUE.equals(old.decision("http://b.example:8080/x","location",false)),"a non-default port keeps its decision");
  check(old.decision("http://b.example/","location",false)==null,"another port is another origin");
  check(old.decision("https://a.example/","camera",true)==null,"a private tab never reads a decision");
  check(old.origins().equals(List.of("https://a.example","http://b.example:8080")),"stored order is kept");
  // Damaged stores grant nothing and every site is asked again.
  for(String damaged:new String[]{"not json","{\"https://a.example\":{\"camera\":true}","[]","{\"https://a.example\":{\"camera\":true}} trailing","{\"https://a.example\" \"camera\"}",""})
   empty(BrowserSitePermissionRecord.read(damaged),"damaged record grants nothing: "+damaged);
  empty(BrowserSitePermissionRecord.read(null),"no record grants nothing");
  // An origin or kind upstream does not recognize grants nothing.
  BrowserSitePermissions odd=BrowserSitePermissionRecord.read("{\"HTTPS://A.example\":{\"camera\":true},\"https://a.example:443\":{\"camera\":true},\"https://c.example\":{\"usb\":true,\"camera\":\"yes\"},\"file:///x\":{\"camera\":true},\"https://d.example\":7}");
  check(odd.decision("https://a.example/","camera",false)==null&&odd.decision("https://c.example/","camera",false)==null,"non-canonical origins and non-boolean decisions grant nothing");
  check(odd.decision("https://c.example/","usb",false)==null,"unknown kinds grant nothing");
  // The 200-origin bound, oldest first, on an old record that exceeds it.
  StringBuilder big=new StringBuilder("{");
  for(int i=0;i<205;i++){if(i>0)big.append(',');big.append("\"https://o").append(i).append(".example\":{\"camera\":").append(i%2==0).append('}');}
  BrowserSitePermissions bounded=BrowserSitePermissionRecord.read(big.append('}').toString());
  check(bounded.origins().size()==BrowserSitePermissions.MAX_ORIGINS,"restored record is bounded to 200");
  check(bounded.origins().get(0).equals("https://o5.example")&&bounded.decision("https://o4.example/","camera",false)==null,"the oldest origins are dropped");
  check(Boolean.TRUE.equals(bounded.decision("https://o204.example/","camera",false))&&Boolean.FALSE.equals(bounded.decision("https://o203.example/","camera",false)),"the newest decisions are kept");
  check(bounded.record("https://new.example/","microphone",true,false),"a new decision is recorded");
  check(bounded.origins().size()==200&&bounded.origins().get(0).equals("https://o6.example")&&bounded.origins().get(199).equals("https://new.example"),"a new origin drops the oldest");
  check(!bounded.record("https://private.example/","camera",true,true)&&!bounded.origins().contains("https://private.example"),"a private tab stores nothing");
  // Written in the same format, oldest first, and read back unchanged.
  String written=BrowserSitePermissionRecord.write(bounded);
  check(written.startsWith("{\"https://o6.example\":"),"written oldest origin first");
  JSONObject parsed=new JSONObject(written);
  check(parsed.length()==200&&parsed.getJSONObject("https://new.example").getBoolean("microphone"),"written record is the old JSON format");
  check(BrowserSitePermissionRecord.read(written).snapshot().equals(bounded.snapshot()),"round trip keeps order and decisions");
  // Clear data for this site removes the site and its subdomains only.
  BrowserSitePermissions sites=BrowserSitePermissionRecord.read("{\"https://example.com\":{\"camera\":true},\"https://a.example.com\":{\"location\":true},\"https://notexample.com\":{\"camera\":true}}");
  check(sites.clearSite("example.com")&&sites.origins().equals(List.of("https://notexample.com")),"site clearing covers subdomains only");
  check(BrowserSitePermissionRecord.write(BrowserSitePermissionRecord.read("{}")).equals("{}"),"an empty record stays empty");
  System.out.println(assertions + " assertions passed");
 }
}
