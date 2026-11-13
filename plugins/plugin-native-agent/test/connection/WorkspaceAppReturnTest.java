package ai.eliza.plugins.agent.connection.test;
import ai.eliza.plugins.agent.connection.WorkspaceAppReturn;
import ai.eliza.plugins.agent.connection.WorkspaceAppReturnFlow;
public class WorkspaceAppReturnTest {
 static int checks;
 static String CALLBACK,HOST;
 static WorkspaceAppReturn POLICY;
 static final String ID="0f8fad5b-d9cb-469f-a165-70867728950e",OTHER="7c9e6679-7425-40de-944b-e07fc1f90ae7";
 static final String NONCE="A".repeat(43),USER="11111111-1111-4111-8111-111111111111",ORG="22222222-2222-4222-8222-222222222222",HASH="a".repeat(64);
 static void check(boolean ok){if(!ok)throw new AssertionError("check "+checks);checks++;}
 interface Work{void run();}
 static void invalid(Work work){try{work.run();}catch(IllegalArgumentException expected){checks++;return;}throw new AssertionError("expected rejection "+checks);}
 static WorkspaceAppReturn.Binding binding(String user,String org,String credential,String hash){return new WorkspaceAppReturn.Binding("production",user,org,credential,hash);}
 public static void main(String[]args){
  CALLBACK=args[0];HOST=java.net.URI.create(CALLBACK).getHost();POLICY=new WorkspaceAppReturn(CALLBACK);
  check("verified".equals(WorkspaceAppReturn.association(true,true,true,false)));
  check("user-selected".equals(WorkspaceAppReturn.association(true,true,false,true)));
  check(WorkspaceAppReturn.association(false,true,true,false)==null);
  check(WorkspaceAppReturn.association(false,true,false,true)==null);
  check(WorkspaceAppReturn.association(true,false,true,false)==null);
  check(WorkspaceAppReturn.association(true,true,false,false)==null);
  String url=CALLBACK+"#state="+NONCE+"&result=connected&connectionId=grant_1";
  WorkspaceAppReturn.Binding owner=binding(USER,ORG,ID,HASH);
  WorkspaceAppReturn.Pending pending=new WorkspaceAppReturn.Pending(owner,NONCE,1000L);
  WorkspaceAppReturn.Callback callback=POLICY.parse(url);
  check(callback!=null&&callback.state.equals(NONCE)&&callback.result.equals("connected")&&callback.connectionId.equals("grant_1"));
  check(WorkspaceAppReturn.accepts(pending,owner,callback,1000));
  check(WorkspaceAppReturn.accepts(pending,owner,callback,600999));
  check(!WorkspaceAppReturn.accepts(pending,owner,callback,601000));
  check(!WorkspaceAppReturn.accepts(pending,owner,callback,999));
  check(!WorkspaceAppReturn.accepts(null,owner,callback,1000));
  check(!WorkspaceAppReturn.accepts(pending,null,callback,1000));
  check(!WorkspaceAppReturn.accepts(pending,owner,null,1000));
  for(String result:new String[]{"denied","failed"}){
   WorkspaceAppReturn.Callback c=POLICY.parse(CALLBACK+"#result="+result+"&state="+NONCE);
   check(c!=null&&c.connectionId==null&&WorkspaceAppReturn.accepts(pending,owner,c,1000));
  }
  for(WorkspaceAppReturn.Binding other:new WorkspaceAppReturn.Binding[]{binding(ORG,ORG,ID,HASH),binding(USER,USER,ID,HASH),binding(USER,ORG,OTHER,HASH),binding(USER,ORG,ID,"b".repeat(64))})check(!WorkspaceAppReturn.accepts(pending,other,callback,1000));
  check(!WorkspaceAppReturn.accepts(pending,owner,new WorkspaceAppReturn.Callback("B".repeat(43),"connected","grant_1"),1000));
  // This pure predicate does not consume; replay resistance belongs to the host's atomic CAS.
  check(WorkspaceAppReturn.accepts(pending,owner,callback,1001));
  for(String bad:new String[]{
   url.replace("https:","http:"),url.replace(HOST,"evil.example"),url.replace(HOST,("user@"+HOST)),url.replace(HOST,(HOST+":443")),url.replace("/gmail/callback","/auth/callback"),url.replace("/gmail/","/gmail%2F"),url.replace("#","?"),url.replace("#","?x=1#"),url+"&extra=x",url+"&state="+NONCE,url+"&connectionId=other",url.replace("state=","%73tate="),url.replace("state=A","state=%41"),url.replace("result=connected","result=%63onnected"),url.replace("result=connected","result=unknown"),url.replace("&connectionId=grant_1",""),url.replace("connectionId=grant_1","connectionId="),url.replace("connectionId=grant_1","connectionId=grant+1"),url.replace("connectionId=grant_1","connectionId=grant%5f1"),url.replace("connectionId=grant_1","connectionId="+"x".repeat(129)),url+"&",url+"#x",CALLBACK,CALLBACK+"#",url.replace(NONCE,"A".repeat(42))
  })check(POLICY.parse(bad)==null);
  check(POLICY.parse(null)==null);
  check(POLICY.parse(CALLBACK+"#state="+NONCE+"&result=denied&connectionId=x")==null);
  check(POLICY.parse(CALLBACK+"#state="+NONCE+"&result=failed&connectionId=x")==null);
  invalid(()->new WorkspaceAppReturn.Binding("staging",USER,ORG,ID,HASH));
  invalid(()->binding("1-1-1-1-1",ORG,ID,HASH));
  invalid(()->binding(USER,"not-uuid",ID,HASH));
  invalid(()->binding(USER,ORG,"",HASH));
  invalid(()->binding(USER,ORG,"x".repeat(257),HASH));
  invalid(()->binding(USER,ORG,"x\ny",HASH));
  invalid(()->binding(USER,ORG," ",HASH));
  invalid(()->binding(USER,ORG,ID,"z".repeat(64)));
  invalid(()->new WorkspaceAppReturn.Pending(owner,"bad",1000));
  invalid(()->new WorkspaceAppReturn.Pending(owner,NONCE,-1));
  invalid(()->new WorkspaceAppReturn.Callback(NONCE,"connected",null));
  invalid(()->new WorkspaceAppReturn.Callback(NONCE,"denied","grant"));
  check(binding(USER,ORG,ID,HASH.toUpperCase()).same(owner));
  System.out.println("PASS Workspace return pure contract "+checks);
 }
}