import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const here=dirname(fileURLToPath(import.meta.url));
const bridge=readFileSync(resolve(here,'../src/main/java/ai/eliza/voice/LocalSpeechBridgePlugin.java'),'utf8');
const gate=readFileSync(resolve(here,'../../src/main/java/ai/eliza/voice/SpeechRequestGate.java'),'utf8');
function method(source,signature){
 const start=source.indexOf(signature);assert.ok(start>=0,signature);
 const open=source.indexOf('{',start);let depth=1,end=open+1;
 for(;depth&&end<source.length;end++){if(source[end]==='{')depth++;else if(source[end]==='}')depth--;}
 assert.equal(depth,0);return source.slice(start,end);
}
// Exercise the production submit method and actual gate, without Android/audio.
const submit=method(bridge,'protected final void submit(');
const rejection=method(bridge,'protected void rejectFailure(');
const java=`import ai.eliza.voice.SpeechRequestGate;
import java.io.*;
import java.net.*;
class JSObject {}
class PluginCall {
 String id; Runnable onReject; String message,code; int rejects,resolves;
 PluginCall(String id){this.id=id;}
 String getString(String k){return id;}
 Boolean getBoolean(String k,boolean fallback){return false;}
 void reject(String m){message=m;rejects++;if(onReject!=null)onReject.run();}
 void reject(String m,String c){code=c;reject(m);}
 void resolve(JSObject value){resolves++;}
}
public class SettlementTest {
 SpeechRequestGate gate=new SpeechRequestGate(); boolean destroyed,deadline,hook; int metadata;
 static final int REQUEST_TIMEOUT_MS=120000;
 class Main {void postDelayed(Runnable r,int timeout){deadline=true;} void removeCallbacks(Runnable r){deadline=false;}}
 Main main=new Main();
 interface Work {void run(SpeechRequestGate.Request request)throws Exception;}
 static String required(String s,int max){if(s==null||s.length()>max)throw new IllegalArgumentException();return s;}
 static final class SpeechHttpException extends IOException {int status;SpeechHttpException(int n){status=n;}}
 static final class Limited extends IOException {}
 boolean submitWork(Runnable work,Runnable refused){work.run();return true;}
 ${submit}
 ${rejection}
 static class Product extends SettlementTest {
  @Override protected void rejectFailure(PluginCall call,String message,String code,Exception error){
   if(error instanceof Limited){hook=true;metadata=429;call.reject(message,"voice-http-429");}
   else super.rejectFailure(call,message,code,error);
  }
 }
 static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  Product p=new Product();PluginCall a=new PluginCall("a"),b=new PluginCall("b");
  a.onReject=()->{check(p.gate.idle(),"gate must be free before reject");check(!p.deadline,"deadline removed before reject");p.submit(b,r->r.result=new JSObject());};
  p.submit(a,r->{throw new Limited();});
  check(a.rejects==1&&"voice-http-429".equals(a.code),"one typed429");
  check(b.resolves==1&&b.rejects==0,"immediate retry accepted");
  Product failed=new Product();PluginCall cleanup=new PluginCall("cleanup"),retry=new PluginCall("retry");
  cleanup.onReject=()->{check(failed.gate.idle()&&!failed.deadline,"cleanup failure released admission");failed.submit(retry,r->r.result=new JSObject());};
  failed.submit(cleanup,r->{r.failureCode="voice-http-429";r.connection=new HttpURLConnection(new URL("https://example.invalid")){
   public void disconnect(){throw new IllegalStateException("cleanup");}
   public boolean usingProxy(){return false;} public void connect(){}
  };throw new Limited();});
  check(cleanup.rejects==1&&"Voice request cleanup failed".equals(cleanup.message),"cleanup failure wins");
  check(cleanup.code==null&&!failed.hook&&failed.metadata==0,"no stale429 metadata after cleanup failure");
  check(retry.resolves==1&&retry.rejects==0,"retry after cleanup failure accepted");
  for(boolean destroy:new boolean[]{false,true}){
   Product q=new Product();PluginCall c=new PluginCall("c");
   q.submit(c,r->{r.connection=new HttpURLConnection(new URL("https://example.invalid")){
    public void disconnect(){if(destroy)q.destroyed=true;else {r.connection=null;r.cancel();}}
    public boolean usingProxy(){return false;} public void connect(){}
   };throw new Limited();});
   check(c.rejects==1&&"Voice request cancelled".equals(c.message),"lifecycle cancellation wins");
   check(!q.hook&&q.metadata==0,"no429 after cancellation");check(q.gate.idle()&&!q.deadline,"cleanup completed");
  }
  System.out.println("post-cleanup rejection, immediate retry, cancel and destroy PASS");
 }
}`;
test('failure settles after gate and deadline cleanup',()=>{
 const folder=mkdtempSync(join(tmpdir(),'speech-settlement-'));
 try {
  const pkg=join(folder,'ai/eliza/voice');mkdirSync(pkg,{recursive:true});
  writeFileSync(join(pkg,'SpeechRequestGate.java'),gate);writeFileSync(join(folder,'SettlementTest.java'),java);
  execFileSync('javac',['--release','11','-d',folder,join(pkg,'SpeechRequestGate.java'),join(folder,'SettlementTest.java')],{timeout:30000});
  assert.match(execFileSync('java',['-cp',folder,'SettlementTest'],{encoding:'utf8',timeout:10000}),/PASS/);
 } finally {rmSync(folder,{recursive:true,force:true});}
});
