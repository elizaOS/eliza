package ai.eliza.plugins.agent.connection.test;
import ai.eliza.plugins.agent.connection.WorkspaceAppReturn;
import ai.eliza.plugins.agent.connection.WorkspaceAppReturnFlow;
import java.util.*;import java.util.concurrent.*;import java.util.concurrent.atomic.*;import org.json.*;
public class WorkspaceAppReturnFlowTest {
 static int checks;
 static String CALLBACK,HOST;
 static WorkspaceAppReturn POLICY;
 static final String ID="0f8fad5b-d9cb-469f-a165-70867728950e",OTHER="7c9e6679-7425-40de-944b-e07fc1f90ae7";
 static final String A="A".repeat(43),B="B".repeat(43),USER="11111111-1111-4111-8111-111111111111",ORG="22222222-2222-4222-8222-222222222222";
 static final String ORIGINAL=new JSONObject().put("credentialId",ID).put("token","synthetic-secret").toString(),CHANGED=new JSONObject().put("credentialId",OTHER).put("token","different").toString();
 static void check(boolean value){if(!value)throw new AssertionError("check "+checks);checks++;}
 interface Work{void run()throws Exception;}static void rejects(Work work)throws Exception{try{work.run();}catch(IllegalArgumentException|IllegalStateException expected){checks++;return;}throw new AssertionError("expected refusal "+checks);}
 static class Memory implements WorkspaceAppReturnFlow.Store {
  String credential=ORIGINAL,pending;int changes;boolean rejectCAS;Runnable afterCAS;
  public synchronized String credential(){return credential;}
  public synchronized String pending(){return pending;}
  public synchronized boolean comparePending(String expected,String next){if(rejectCAS||!Objects.equals(expected,pending))return false;pending=next;changes++;Runnable hook=afterCAS;afterCAS=null;if(hook!=null)hook.run();return true;}
 }
 static WorkspaceAppReturn.Binding owner(Memory m){return WorkspaceAppReturnFlow.binding("production",USER,ORG,ID,m.credential,1000);}
 static String callback(String nonce,String result){return CALLBACK+"#state="+nonce+"&result="+result+(result.equals("connected")?"&connectionId=grant_1":"");}
 public static void main(String[]args)throws Exception{
  CALLBACK=args[0];HOST=java.net.URI.create(CALLBACK).getHost();POLICY=new WorkspaceAppReturn(CALLBACK);
  Memory m=new Memory();WorkspaceAppReturn.Binding binding=owner(m);WorkspaceAppReturnFlow flow=new WorkspaceAppReturnFlow(POLICY,m);
  check(flow.prepare(binding,A,1000).equals(CALLBACK+"?state="+A));
  JSONObject record=new JSONObject(m.pending);check(record.length()==7&&!record.has("sessionId")&&!m.pending.contains("synthetic-secret")&&!m.pending.contains("token"));check(m.credential.equals(ORIGINAL));
  int writes=m.changes;check(flow.captureAllowed(callback(A,"connected"),1001));check(m.changes==writes);check(!flow.captureAllowed(callback(B,"connected"),1001));check(m.changes==writes);
  WorkspaceAppReturn.Callback result=flow.consume(binding,callback(A,"connected"),1001);check(result!=null&&result.connectionId.equals("grant_1")&&m.pending==null);check(flow.consume(binding,callback(A,"connected"),1002)==null);check(m.credential.equals(ORIGINAL));
  for(String status:new String[]{"denied","failed"}){flow.prepare(binding,A,1000);result=flow.consume(binding,callback(A,status),1001);check(result!=null&&result.result.equals(status)&&result.connectionId==null);check(m.pending==null&&m.credential.equals(ORIGINAL));}
  flow.prepare(binding,A,1000);String retained=m.pending;check(flow.consume(binding,callback(B,"connected"),1001)==null&&m.pending.equals(retained));flow.cancel(B);check(m.pending.equals(retained));flow.cancel(A);check(m.pending==null);
  flow.prepare(binding,A,1000);flow.prepare(binding,B,1001);check(flow.consume(binding,callback(A,"connected"),1002)==null);flow.cancel(A);check(m.pending!=null);check(flow.consume(binding,callback(B,"connected"),1002)!=null);
  for(long now:new long[]{999,601000,Long.MAX_VALUE}){flow.prepare(binding,A,1000);retained=m.pending;check(!flow.captureAllowed(callback(A,"connected"),now));check(flow.consume(binding,callback(A,"connected"),now)==null&&m.pending.equals(retained));}
  flow.prepare(binding,A,1000);WorkspaceAppReturn.Binding other=new WorkspaceAppReturn.Binding("production",USER,ORG,OTHER,binding.credentialHash);check(flow.consume(other,callback(A,"connected"),1001)==null);check(m.pending!=null);
  other=new WorkspaceAppReturn.Binding("production",ORG,ORG,ID,binding.credentialHash);check(flow.consume(other,callback(A,"connected"),1001)==null);
  m.credential=null;check(!flow.captureAllowed(callback(A,"connected"),1001));check(flow.consume(binding,callback(A,"connected"),1001)==null);m.credential=CHANGED;check(!flow.captureAllowed(callback(A,"connected"),1001));check(flow.consume(binding,callback(A,"connected"),1001)==null);rejects(()->flow.prepare(binding,B,1002));m.credential=ORIGINAL;
  m.rejectCAS=true;retained=m.pending;check(flow.consume(binding,callback(A,"connected"),1001)==null&&m.pending.equals(retained));rejects(()->flow.prepare(binding,B,1001));m.rejectCAS=false;
  // A credential change immediately after installing pending rolls back only that exact pending value.
  m.pending=null;m.afterCAS=()->m.credential=CHANGED;rejects(()->flow.prepare(binding,A,1000));check(m.pending==null);m.credential=ORIGINAL;
  m.afterCAS=()->{m.credential=CHANGED;m.pending="newer-attempt";};rejects(()->flow.prepare(binding,A,1000));check(m.pending.equals("newer-attempt"));m.credential=ORIGINAL;m.pending=null;
  flow.prepare(binding,A,1000);m.afterCAS=()->m.credential=CHANGED;check(flow.consume(binding,callback(A,"connected"),1001)==null&&m.pending==null);m.credential=ORIGINAL;
  // Expiry refresh and JSON reserialization do not replace credential authority.
  flow.prepare(binding,A,1000);m.credential=new JSONObject(ORIGINAL).put("expiresAt",1001).toString();
  check(!flow.captureAllowed(callback(A,"connected"),1001));check(flow.consume(binding,callback(A,"connected"),1001)==null);m.credential=ORIGINAL;
  flow.prepare(binding,A,1000);m.credential=new JSONObject(ORIGINAL).put("expiresAt",7200000).put("description","metadata only").toString();check(flow.captureAllowed(callback(A,"connected"),1001));check(flow.consume(binding,callback(A,"connected"),1001)!=null);m.credential=ORIGINAL;
  flow.prepare(binding,A,1000);m.credential=new JSONObject().put("token","synthetic-secret").put("credentialId",ID).toString();check(flow.consume(binding,callback(A,"connected"),1001)!=null);m.credential=ORIGINAL;
  for(String identityField:new String[]{"credentialId","token","userId","organizationId"}){flow.prepare(binding,A,1000);m.credential=new JSONObject(ORIGINAL).put(identityField,"changed-authority").toString();check(!flow.captureAllowed(callback(A,"connected"),1001));check(flow.consume(binding,callback(A,"connected"),1001)==null);m.credential=ORIGINAL;}
  // Cold recreation rebuilds the durable binding; ephemeral UI sessions do not enter native state.
  flow.prepare(binding,A,1000);check(new WorkspaceAppReturnFlow(POLICY,m).consume(owner(m),callback(A,"connected"),1001)!=null);
  // Exactly one concurrent consumer wins the existing store CAS.
  flow.prepare(binding,A,1000);ExecutorService pool=Executors.newFixedThreadPool(2);CountDownLatch ready=new CountDownLatch(1);AtomicInteger accepted=new AtomicInteger();List<Future<?>> tasks=new ArrayList<>();
  for(int i=0;i<2;i++)tasks.add(pool.submit(()->{try{ready.await();if(new WorkspaceAppReturnFlow(POLICY,m).consume(owner(m),callback(A,"connected"),1001)!=null)accepted.incrementAndGet();}catch(Exception e){throw new RuntimeException(e);}}));ready.countDown();for(Future<?> task:tasks)task.get();pool.shutdown();check(accepted.get()==1&&m.pending==null);
  for(String malformed:new String[]{"{}","not-json",new JSONObject().put("state",A).toString(),record.put("extra",true).toString()}){m.pending=malformed;writes=m.changes;check(!flow.captureAllowed(callback(A,"connected"),1001));check(flow.consume(binding,callback(A,"connected"),1001)==null&&m.changes==writes);}
  m.pending=null;flow.prepare(binding,A,1000);retained=m.pending;check(!flow.captureAllowed(callback(A,"connected")+"&unknown=x",1001));check(flow.consume(binding,callback(A,"connected")+"&unknown=x",1001)==null&&m.pending.equals(retained));
  rejects(()->WorkspaceAppReturnFlow.binding("production",USER,ORG,"wrong",ORIGINAL,1000));
  rejects(()->WorkspaceAppReturnFlow.binding("production",USER,ORG,"credential",new JSONObject(ORIGINAL).put("credentialId","credential").toString(),1000));
  rejects(()->WorkspaceAppReturnFlow.binding("production",USER,ORG,ID,"{\"credentialId\":\"credential\"}",1000));
  rejects(()->WorkspaceAppReturnFlow.binding("production",USER,ORG,ID,ORIGINAL+" trailing",1000));
  rejects(()->WorkspaceAppReturnFlow.binding("production",USER,ORG,ID,"{\"credentialId\":\"credential\",\"token\":\" \"}",1000));
  check(m.credential.equals(ORIGINAL));System.out.println("PASS Workspace flow "+checks);
 }
}
