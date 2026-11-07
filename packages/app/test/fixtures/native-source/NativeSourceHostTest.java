package ai.elizaos.app;
import org.json.JSONObject;
public final class NativeSourceHostTest {
 interface Work{void run()throws Exception;}
 static void rejects(Work work)throws Exception{try{work.run();}catch(SecurityException expected){return;}throw new AssertionError("Expected denial");}
 public static void main(String[] args)throws Exception {
  JSONObject request=new JSONObject().put("sourceId","selected");
  rejects(()->NativeSourceHost.read(request,10001,10001));
  int[] calls={0};NativeSourceHost.configure(input->{calls[0]++;input.put("observed",true);return input;});
  rejects(()->NativeSourceHost.read(request,10002,10001));
  if(calls[0]!=0)throw new AssertionError("Foreign UID reached source callback");
  JSONObject result=NativeSourceHost.read(request,10001,10001);
  if(calls[0]!=1||!result.getBoolean("observed")||request.has("observed"))throw new AssertionError("Wrong native callback boundary");
  System.out.println("PASS native source host: default unavailable, foreign UID denied, app UID admitted, input snapshot isolated");
 }
}
