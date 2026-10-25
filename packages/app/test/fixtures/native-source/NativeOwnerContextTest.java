package ai.elizaos.app;
import org.json.JSONObject;
public final class NativeOwnerContextTest {
 interface Work{void run()throws Exception;}
 static void denied(Work work)throws Exception{try{work.run();}catch(SecurityException expected){return;}throw new AssertionError("Expected denial");}
 static JSONObject context()throws Exception{return new JSONObject().put("protocol",1).put("subjectUserId","native-owner").put("agentId","native-agent").put("installationId","native-install").put("enrollmentId","native-enrollment").put("accountRef","native-account").put("environment","production").put("sessionGeneration","durable-native-generation");}
 public static void main(String[] args)throws Exception {
  try{NativeSourceHost.readOwnerReminderContext(10001,10001);throw new AssertionError("Missing callback became ready");}catch(UnsupportedOperationException expected){}
  int[] calls={0},variant={0};JSONObject[] last={null};
  NativeSourceHost.OwnerReminderContextReader reader=()->{calls[0]++;JSONObject value=context();if(variant[0]==1)value.put("token","secret");if(variant[0]==2)value.put("protocol","1");if(variant[0]==3)value.put("sessionGeneration","");last[0]=value;return value;};
  NativeSourceHost.configureOwnerReminderContext(reader);NativeSourceHost.configureOwnerReminderContext(reader);
  denied(()->NativeSourceHost.readOwnerReminderContext(10002,10001));if(calls[0]!=0)throw new AssertionError("Foreign UID reached callback");
  JSONObject result=NativeSourceHost.readOwnerReminderContext(10001,10001);last[0].put("sessionGeneration","changed");if(!"durable-native-generation".equals(result.getString("sessionGeneration")))throw new AssertionError("Native snapshot was not copied");
  for(int n=1;n<=3;n++){variant[0]=n;denied(()->NativeSourceHost.readOwnerReminderContext(10001,10001));}
  denied(()->{try{NativeSourceHost.configureOwnerReminderContext(()->context());}catch(IllegalStateException expected){throw new SecurityException();}});
  variant[0]=0;System.out.println("PASS native owner context: unavailable/UID/whitelist/protocol/generation/snapshot/configuration fences");
 }
}
