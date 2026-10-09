package ai.elizaos.app;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Process;
import android.os.SystemClock;
import android.system.Os;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/** Android socket/peer-credential proof only; does not qualify full resident restart recovery. */
public final class WorkflowSurvivorPeerInstrumentedTest {
 private String hash(byte[] data)throws Exception {StringBuilder value=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(data))value.append(String.format(Locale.ROOT,"%02x",b&255));return value.toString();}
 private void mkdir(File file)throws Exception {assertTrue(file.mkdirs());Os.chmod(file.getPath(),0700);}
 private void write(File file,String data)throws Exception {try(FileOutputStream out=new FileOutputStream(file)){out.write(data.getBytes(StandardCharsets.UTF_8));out.getFD().sync();}Os.chmod(file.getPath(),0600);}
 private void remove(File file){File[] children=file.listFiles();if(children!=null)for(File child:children)remove(child);assertTrue(file.delete());}
 @Test public void authenticatedPeerMatchesKernelIdentityAndWrongGenerationFails()throws Exception {
  File home=new File(InstrumentationRegistry.getInstrumentation().getTargetContext().getFilesDir().getCanonicalFile(),"wr-"+UUID.randomUUID().toString().substring(0,8));mkdir(home);
  try {
   File root=new File(home,".ew");mkdir(root);File workflow=new File(home,"w");mkdir(workflow);String run="synthetic",version="v1",content="export default {};",sourceHash=hash(content.getBytes(StandardCharsets.UTF_8));File source=new File(workflow,version+"."+sourceHash+".ts");write(source,content);File active=new File(workflow,".worker-owners/"+hash(run.getBytes(StandardCharsets.UTF_8)));mkdir(active);Os.chmod(active.getParent(),0700);
   WorkflowSurvivorInventory.Identity identity=WorkflowSurvivorInventory.processIdentity(Process.myPid());String generation=UUID.randomUUID().toString(),capability=hash(UUID.randomUUID().toString().getBytes(StandardCharsets.UTF_8));File endpoint=new File(root,"12345678901234567890.sock");File journal=new File(active,"owner.json");
   JSONObject owner=new JSONObject().put("schemaVersion",2).put("uid",identity.uid).put("pid",identity.pid).put("executable",identity.executable).put("generation",generation).put("capability",capability).put("runId",run).put("versionId",version).put("sourceSha256",sourceHash).put("sourcePath",source.getPath()).put("endpoint",endpoint.getPath()).put("nativeIdentity",new JSONObject().put("pid",identity.pid).put("uid",identity.uid).put("startTicks",identity.start).put("executable",identity.executable).put("device",identity.device).put("inode",identity.inode).put("sha256",identity.sha256));write(journal,owner.toString());
   try(LocalSocket binding=new LocalSocket()){binding.bind(new LocalSocketAddress(endpoint.getPath(),LocalSocketAddress.Namespace.FILESYSTEM));Os.chmod(endpoint.getPath(),0600);
    try(LocalServerSocket server=new LocalServerSocket(binding.getFileDescriptor())){
     for(boolean wrong:new boolean[]{false,true}) {
      AtomicReference<Throwable> failure=new AtomicReference<>();Thread responder=new Thread(()->{try(LocalSocket peer=server.accept()){peer.setSoTimeout(2000);String line=new BufferedReader(new InputStreamReader(peer.getInputStream(),StandardCharsets.UTF_8)).readLine();JSONObject request=new JSONObject(line);if(!capability.equals(request.getString("capability")))throw new AssertionError("Capability differs");peer.getOutputStream().write((new JSONObject().put("challenge",request.getString("challenge")).put("generation",wrong?UUID.randomUUID().toString():generation).toString()+"\n").getBytes(StandardCharsets.UTF_8));}catch(Throwable error){failure.set(error);}});responder.setDaemon(true);responder.start();
      if(wrong)assertThrows(Exception.class,()->WorkflowSurvivorInventory.verify(journal,owner,identity,home,identity.executable,identity.executable,identity.sha256,SystemClock.elapsedRealtime()+5000));
      else WorkflowSurvivorInventory.verify(journal,owner,identity,home,identity.executable,identity.executable,identity.sha256,SystemClock.elapsedRealtime()+5000);
      responder.join(3000);assertFalse(responder.isAlive());assertNull(failure.get());
     }
    }
   }
  } finally {remove(home);}
 }
}
