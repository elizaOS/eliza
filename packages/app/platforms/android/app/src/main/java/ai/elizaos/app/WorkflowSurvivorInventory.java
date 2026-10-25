package ai.elizaos.app;

import android.net.Credentials;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Process;
import android.os.SystemClock;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.json.JSONObject;

/** Survivor classification and exact resident termination. No deletion, permission changes or PID-only exemptions. */
final class WorkflowSurvivorInventory {
 private static IOException refused(String message){return new IOException("IPC recovery required: "+message);}
 private static void check(boolean value,String message)throws IOException {if(!value)throw refused(message);}
 private static StructStat owned(File file,int kind,int mode)throws Exception {
  StructStat s=Os.lstat(file.getPath());check(s.st_uid==Process.myUid()&&(s.st_mode&OsConstants.S_IFMT)==kind&&(s.st_mode&0777)==mode,"untrusted worker journal");
  check(file.getCanonicalPath().equals(file.getPath()),"worker path alias");return s;
 }
 private static byte[] bounded(File file,int limit)throws Exception {
  try(InputStream in=new FileInputStream(file)){ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[1024];int n;
   while((n=in.read(buffer))!=-1){check(n<=limit-out.size(),"worker metadata exceeds bound");out.write(buffer,0,n);}return out.toByteArray();}
 }
 private static String hash(File file)throws Exception { return hash(file,Long.MAX_VALUE); }
 private static String hash(File file,long deadline)throws Exception {
  MessageDigest digest=MessageDigest.getInstance("SHA-256");try(InputStream in=new FileInputStream(file)){byte[] buffer=new byte[65536];long size=0;int n;
   while((n=in.read(buffer))!=-1){check(SystemClock.elapsedRealtime()<deadline,"worker inventory deadline");size+=n;check(size<=128L*1024*1024,"worker executable/source exceeds bound");digest.update(buffer,0,n);}}
  StringBuilder value=new StringBuilder();for(byte b:digest.digest())value.append(String.format(Locale.ROOT,"%02x",b&255));return value.toString();
 }
 private static String hashText(String text)throws Exception {MessageDigest digest=MessageDigest.getInstance("SHA-256");StringBuilder value=new StringBuilder();for(byte b:digest.digest(text.getBytes(StandardCharsets.UTF_8)))value.append(String.format(Locale.ROOT,"%02x",b&255));return value.toString();}
 static final class Identity {
  final int pid,uid;final String start,executable,device,inode,sha256;
  Identity(int pid,int uid,String start,String executable,String device,String inode,String sha256){this.pid=pid;this.uid=uid;this.start=start;this.executable=executable;this.device=device;this.inode=inode;this.sha256=sha256;}
  String key(){return pid+":"+uid+":"+start+":"+executable+":"+device+":"+inode+":"+sha256;}
 }
 static Identity processIdentity(int pid)throws Exception {return processIdentity(pid,Long.MAX_VALUE);}
 private static Identity processIdentity(int pid,long deadline)throws Exception {
  File proc=new File("/proc/"+pid);StructStat before=Os.stat(proc.getPath());String stat=new String(bounded(new File(proc,"stat"),16384),StandardCharsets.UTF_8);int end=stat.lastIndexOf(')');check(end>=0,"malformed worker process");String[] fields=stat.substring(end+2).trim().split("\\s+");check(fields.length>19&&fields[19].matches("[0-9]+"),"missing worker start time");
  File link=new File(proc,"exe");String executable=Os.readlink(link.getPath());check(executable.startsWith("/")&&!executable.endsWith(" (deleted)"),"invalid worker executable");StructStat exe=Os.stat(link.getPath());String digest=hash(link,deadline);StructStat after=Os.stat(proc.getPath());check(before.st_uid==after.st_uid&&before.st_ino==after.st_ino,"worker process changed");return new Identity(pid,before.st_uid,fields[19],executable,String.valueOf(exe.st_dev),String.valueOf(exe.st_ino),digest);
 }
 interface ProcessObservation<T> { T read()throws Exception; }
 interface ProcessPresence { boolean live(int pid)throws Exception; }
 /** An observation failure is benign only after fresh absence or stable terminal-state proof. */
 static <T> T observePresent(int pid,ProcessObservation<T> observation,ProcessPresence presence)throws Exception {
  try{return observation.read();}
  catch(Exception failure){
   try{if(!presence.live(pid))return null;}
   catch(android.system.ErrnoException absent){if(absent.errno==OsConstants.ENOENT)return null;throw failure;}
   catch(Exception uncertain){throw failure;}
   throw failure;
  }
 }
 static String terminalStateKey(int pid,String stat)throws IOException {
  int end=stat.lastIndexOf(')');
  if(!stat.startsWith(pid+" (")||end<0||end+2>=stat.length()||stat.charAt(end+1)!=' ')throw new IOException("malformed process state");
  String[] fields=stat.substring(end+2).trim().split("\\s+");
  if(fields.length<20||!fields[19].matches("[0-9]+")||!fields[0].matches("[RSDZTtXxKWPIN]"))throw new IOException("invalid process state");
  return fields[0].matches("[ZXx]")?pid+":"+fields[19]:null;
 }
 private static boolean liveProcess(int pid)throws Exception {
  File proc=new File("/proc/"+pid),state=new File(proc,"stat");
  StructStat before=Os.stat(proc.getPath());
  String first=terminalStateKey(pid,new String(bounded(state,16384),StandardCharsets.UTF_8));
  if(first==null)return true;
  String second=terminalStateKey(pid,new String(bounded(state,16384),StandardCharsets.UTF_8));
  StructStat after=Os.stat(proc.getPath());
  check(before.st_uid==after.st_uid&&before.st_ino==after.st_ino&&first.equals(second),"terminal process changed");
  return false;
 }
 private static <T> T observePresent(int pid,ProcessObservation<T> observation)throws Exception {
  return observePresent(pid,observation,WorkflowSurvivorInventory::liveProcess);
 }
 /** Only the exact resident command is signalable; shared-runtime siblings are preserved. */
 static boolean residentArguments(byte[] bytes,String bun,String loader,String bundle)throws Exception {
  check(bytes.length>0&&bytes.length<=65536&&bytes[bytes.length-1]==0,"incomplete resident argv");
  String[] args=new String(bytes,StandardCharsets.UTF_8).split(String.valueOf((char)0),-1);
  if(args.length!=5&&args.length!=6)return false;
  return args[args.length-1].isEmpty()&&args[0].equals(loader)&&args[1].equals(bun)
   &&args[2].equals("--no-install")&&args[3].equals(bundle)
   &&(args.length==5||args[4].equals("android-bridge"));
 }
 static void stopResident(File suppliedBun,File suppliedLoader,File suppliedBundle)throws Exception {
  long deadline=SystemClock.elapsedRealtime()+5000;
  String bun=suppliedBun.getCanonicalPath(),loader=suppliedLoader.getCanonicalPath(),bundle=suppliedBundle.getCanonicalPath();
  check(bun.equals(suppliedBun.getPath())&&loader.equals(suppliedLoader.getPath())&&bundle.equals(suppliedBundle.getPath()),"resident deployment alias");
  StructStat packaged=Os.stat(loader);String loaderHash=hash(new File(loader),deadline);
  File[] entries=new File("/proc").listFiles();check(entries!=null&&entries.length>=20,"incomplete resident stop inventory");
  Identity selected=null;byte[] selectedArgs=null;
  for(File entry:entries){
   check(SystemClock.elapsedRealtime()<deadline,"resident stop inventory deadline");
   if(!entry.getName().matches("[0-9]+"))continue;
   StructStat stat;try{stat=Os.stat(entry.getPath());}catch(android.system.ErrnoException gone){if(gone.errno==OsConstants.ENOENT)continue;throw gone;}
   if(stat.st_uid!=Process.myUid()||entry.getName().equals(String.valueOf(Process.myPid())))continue;
   final int pid=Integer.parseInt(entry.getName());
   byte[] args=observePresent(pid,()->bounded(new File(entry,"cmdline"),65536));if(args==null)continue;
   if(!residentArguments(args,bun,loader,bundle))continue;
   check(selected==null,"multiple resident processes; preserve all");
   Identity identity=observePresent(pid,()->processIdentity(pid,deadline));if(identity==null)continue;
   check(identity.uid==Process.myUid()&&identity.executable.equals(loader)&&identity.sha256.equals(loaderHash)
    &&identity.device.equals(String.valueOf(packaged.st_dev))&&identity.inode.equals(String.valueOf(packaged.st_ino)),"resident deployment changed");
   if(observePresent(pid,()->mappedBunIdentity(pid,bun,deadline))==null)continue;selected=identity;selectedArgs=args;
  }
  if(selected==null)return;
  final Identity target=selected;final byte[] targetArgs=selectedArgs;
  if(observePresent(target.pid,()->{check(target.key().equals(processIdentity(target.pid,deadline).key())&&Arrays.equals(targetArgs,bounded(new File("/proc/"+target.pid+"/cmdline"),65536)),"resident changed before signal");return Boolean.TRUE;})==null)return;
  // The full UID/start/executable identity is rechecked immediately before signaling.
  if(observePresent(target.pid,()->{Os.kill(target.pid,OsConstants.SIGTERM);return Boolean.TRUE;})==null)return;
  while(SystemClock.elapsedRealtime()<deadline){
   Identity current;
   try {current=observePresent(target.pid,()->processIdentity(target.pid,deadline));}
   catch(android.system.ErrnoException transition){
    // SIGTERM can remove /proc/PID/exe before the process becomes terminal.
    // Retry observation only: no additional signal and no success without proof.
    if(transition.errno!=OsConstants.ENOENT)throw transition;
    SystemClock.sleep(50);continue;
   }
   catch(FileNotFoundException transition){SystemClock.sleep(50);continue;}
   if(current==null)return;
   check(target.key().equals(current.key()),"resident PID changed after signal");
   SystemClock.sleep(50);
  }
  throw refused("resident stop unconfirmed; preserve processes");
 }
 private static Map<Integer,Identity> processes(long deadline)throws Exception {
  File[] entries=new File("/proc").listFiles();check(entries!=null&&entries.length>=20,"incomplete process inventory");Map<Integer,Identity> result=new TreeMap<>();
  for(File entry:entries){if(!entry.getName().matches("[0-9]+"))continue;StructStat stat;
   try{stat=Os.stat(entry.getPath());}catch(android.system.ErrnoException missing){if(missing.errno==OsConstants.ENOENT)continue;throw missing;}
   if(stat.st_uid!=Process.myUid())continue;int pid=Integer.parseInt(entry.getName());result.put(pid,processIdentity(pid,deadline));check(result.size()<=32,"too many same-UID processes");}
  check(result.containsKey(Process.myPid()),"current process absent");return result;
 }
 private static File[] children(File directory,int[] budget)throws Exception {
  StructStat stat=Os.lstat(directory.getPath());check(OsConstants.S_ISDIR(stat.st_mode)&&stat.st_uid==Process.myUid()&&(stat.st_mode&0022)==0&&directory.getCanonicalPath().equals(directory.getPath()),"untrusted workflow state directory");File[] entries=directory.listFiles();check(entries!=null,"workflow inventory unavailable");budget[0]+=entries.length;check(budget[0]<=4096,"workflow journal inventory exceeds bound");return entries;
 }
 private static boolean directory(File file)throws Exception {return OsConstants.S_ISDIR(Os.lstat(file.getPath()).st_mode);}
 private static List<File> journals(File state)throws Exception {
  List<File> result=new ArrayList<>();int[] budget={0};
  for(File tenant:children(state,budget)) {
   try{if(!directory(tenant))continue;}catch(Exception unproven){continue;}
   File[] workflows;try{workflows=children(tenant,budget);}catch(Exception unproven){continue;}
   for(File workflow:workflows) {
    try{if(!directory(workflow))continue;}catch(Exception unproven){continue;}File owners=new File(workflow,".worker-owners");File[] candidates;
    try{owned(owners,OsConstants.S_IFDIR,0700);candidates=children(owners,budget);}catch(Exception unproven){continue;}
    for(File active:candidates) {
     if(!active.getName().matches("[a-f0-9]{64}"))continue;
     try{owned(active,OsConstants.S_IFDIR,0700);}catch(Exception unproven){continue;}
     result.add(new File(active,"owner.json"));check(result.size()<=256,"too many active worker journals");
    }
   }
  }
  check(budget[0]<=4096,"workflow journal inventory exceeds bound");
  return result;
 }
 static void verifyBinding(JSONObject owner,Identity observed,int peerUid,int peerPid,String expectedBun,String expectedLoader,String expectedLoaderHash)throws Exception {
  check(owner.getInt("schemaVersion")==2,"incomplete native worker journal");JSONObject nativeIdentity=owner.getJSONObject("nativeIdentity");
  check(owner.getInt("uid")==observed.uid&&owner.getInt("pid")==observed.pid&&peerUid==observed.uid&&peerPid==observed.pid,"worker peer identity differs");
  check(nativeIdentity.getInt("pid")==observed.pid&&nativeIdentity.getInt("uid")==observed.uid&&nativeIdentity.getString("startTicks").equals(observed.start),"worker PID/start identity differs");
  check(owner.getString("executable").equals(expectedLoader)&&observed.executable.equals(expectedLoader)&&observed.sha256.equals(expectedLoaderHash),"worker deployment differs");
  check(nativeIdentity.getString("executable").equals(observed.executable)&&nativeIdentity.getString("device").equals(observed.device)&&nativeIdentity.getString("inode").equals(observed.inode)&&nativeIdentity.getString("sha256").equals(observed.sha256),"worker executable identity differs");
 }
 // The Android wrapper execs musl; process.execPath identifies musl, not its mapped Bun image.
 // Bind the packaged Bun independently using kernel maps plus the immutable packaged file.
 static String verifyMappedBunText(String maps,String bun,long device,long inode)throws Exception {
  check(maps.length()<=4*1024*1024&&maps.endsWith("\n"),"incomplete or oversized worker maps");
  StringBuilder matched=new StringBuilder();boolean executable=false;int lines=0;
  for(String line:maps.split("\n")) {
   check(++lines<=32768&&line.length()<=8192,"worker maps exceeds bound");
   String[] fields=line.trim().split("\\s+",6);
   check(fields.length>=5&&fields[0].matches("[a-fA-F0-9]+-[a-fA-F0-9]+")&&fields[1].matches("[r-][w-][x-][ps]")&&fields[2].matches("[a-fA-F0-9]+")&&fields[3].matches("[a-fA-F0-9]+:[a-fA-F0-9]+")&&fields[4].matches("[0-9]+"),"malformed worker maps");
   if(fields.length!=6)continue;
   String mappedPath=fields[5];
   if(mappedPath.equals(bun+" (deleted)"))throw refused("mapped Bun was deleted");
   if(!mappedPath.equals(bun))continue;
   String[] dev=fields[3].split(":");long major=Long.parseLong(dev[0],16),minor=Long.parseLong(dev[1],16);
   check(major<=0xffffffffL&&minor<=0xffffffffL,"invalid mapped Bun device");
   long mappedDevice=((major&0xfffL)<<8)|(minor&0xffL)|((major&~0xfffL)<<32)|((minor&~0xffL)<<12);
   check(mappedDevice==device&&Long.parseLong(fields[4])==inode,"mapped Bun file identity differs");
   String[] addresses=fields[0].split("-");check(Long.compareUnsigned(Long.parseUnsignedLong(addresses[0],16),Long.parseUnsignedLong(addresses[1],16))<0,"invalid mapped Bun address range");
   if(fields[1].charAt(2)=='x'){check(fields[1].charAt(1)!='w',"writable executable Bun mapping");executable=true;}
   matched.append(line).append('\n');
  }
  check(executable,"packaged Bun executable mapping absent");return matched.toString();
 }
 private static String mappedBunIdentity(int pid,String bun,long deadline)throws Exception {
  File file=new File(bun);check(file.getCanonicalPath().equals(bun),"mapped Bun path alias");
  java.io.FileDescriptor descriptor=Os.open(bun,OsConstants.O_RDONLY|OsConstants.O_CLOEXEC|OsConstants.O_NOFOLLOW,0);
  try(FileInputStream in=new FileInputStream(descriptor)) {
   StructStat first=Os.fstat(descriptor);check(OsConstants.S_ISREG(first.st_mode)&&(first.st_mode&0022)==0&&first.st_size>0&&first.st_size<=128L*1024*1024,"untrusted packaged Bun file");
   MessageDigest digest=MessageDigest.getInstance("SHA-256");byte[] buffer=new byte[65536];long size=0;int n;
   while((n=in.read(buffer))!=-1){check(SystemClock.elapsedRealtime()<deadline,"worker inventory deadline");size+=n;check(size<=128L*1024*1024,"packaged Bun exceeds bound");digest.update(buffer,0,n);}
   StringBuilder sha=new StringBuilder();for(byte value:digest.digest())sha.append(String.format(Locale.ROOT,"%02x",value&255));
   ByteArrayOutputStream maps=new ByteArrayOutputStream();try(InputStream proc=new FileInputStream("/proc/"+pid+"/maps")){
    while((n=proc.read(buffer))!=-1){check(SystemClock.elapsedRealtime()<deadline,"worker inventory deadline");check(n<=4*1024*1024-maps.size(),"worker maps exceeds bound");maps.write(buffer,0,n);}
   }
   String selected=verifyMappedBunText(maps.toString(StandardCharsets.UTF_8.name()),bun,first.st_dev,first.st_ino);
   StructStat last=Os.fstat(descriptor),current=Os.lstat(bun);
   check(first.st_dev==last.st_dev&&first.st_ino==last.st_ino&&first.st_size==last.st_size&&first.st_mtime==last.st_mtime&&first.st_ctime==last.st_ctime&&first.st_dev==current.st_dev&&first.st_ino==current.st_ino&&first.st_size==current.st_size&&first.st_mtime==current.st_mtime&&first.st_ctime==current.st_ctime&&size==first.st_size,"packaged Bun changed during observation");
   return bun+":"+first.st_dev+":"+first.st_ino+":"+first.st_size+":"+sha+"\n"+selected;
  }
 }
 static void verify(File journal,JSONObject owner,Identity observed,File home,String bun,String loader,String loaderHash,long deadline)throws Exception {
  StructStat first=owned(journal,OsConstants.S_IFREG,0600);check(first.st_size<=16384,"worker journal too large");String journalHash=hash(journal,deadline);check(owner.toString().equals(new JSONObject(new String(bounded(journal,16384),StandardCharsets.UTF_8)).toString()),"worker journal changed before challenge");String generation=owner.getString("generation"),capability=owner.getString("capability"),run=owner.getString("runId"),version=owner.getString("versionId"),sourceHash=owner.getString("sourceSha256");check(generation.matches("[a-f0-9-]{36}")&&capability.matches("[a-f0-9]{64}")&&sourceHash.matches("[a-f0-9]{64}"),"invalid worker generation");check(journal.getParentFile().getName().equals(hashText(run)),"worker run scope differs");
  File workflow=journal.getParentFile().getParentFile().getParentFile();File source=new File(owner.getString("sourcePath"));String safeVersion=version.replaceAll("[^a-zA-Z0-9_.-]+","-").replaceAll("^-+|-+$","");if(safeVersion.isEmpty())safeVersion="workflow";
  check(source.getParentFile().equals(workflow)&&source.getName().matches(java.util.regex.Pattern.quote(safeVersion+"."+sourceHash)+"\\.tsx?"),"worker source scope differs");StructStat sourceStat=owned(source,OsConstants.S_IFREG,0600);check(hash(source,deadline).equals(sourceHash),"worker source hash differs");
  File endpoint=new File(owner.getString("endpoint"));File socketRoot=endpoint.getParentFile();check(socketRoot.equals(new File(home,".eliza-worker-ipc"))||socketRoot.equals(new File(home,".ew")),"worker endpoint escaped application");owned(socketRoot,OsConstants.S_IFDIR,0700);check(endpoint.getName().matches("[a-f0-9]{20}\\.sock")&&endpoint.getPath().getBytes(StandardCharsets.UTF_8).length<=100,"invalid worker endpoint");StructStat endpointStat=owned(endpoint,OsConstants.S_IFSOCK,0600);
  verifyBinding(owner,observed,observed.uid,observed.pid,bun,loader,loaderHash);
  String bunIdentity=mappedBunIdentity(observed.pid,bun,deadline);
  String challenge=UUID.randomUUID().toString();check(SystemClock.elapsedRealtime()<deadline,"worker inventory deadline");
  try(LocalSocket socket=new LocalSocket()){
   // LocalSocket options do not create its lazy file descriptor. This public
   // stream accessor creates it before timeout setup and the close watchdog.
   InputStream responseStream=socket.getInputStream();
   long challengeDeadline=Math.min(deadline,SystemClock.elapsedRealtime()+1000L);
   int timeout=(int)(challengeDeadline-SystemClock.elapsedRealtime());
   check(timeout>0,"worker inventory deadline");
   socket.setSoTimeout(timeout);
   // An absolute watchdog covers connect, writes and slow byte-by-byte replies.
   java.util.concurrent.atomic.AtomicBoolean expired=new java.util.concurrent.atomic.AtomicBoolean();
   Thread watchdog=new Thread(()->{try{Thread.sleep(Math.max(0L,challengeDeadline-SystemClock.elapsedRealtime()));expired.set(true);socket.close();}catch(InterruptedException stopped){Thread.currentThread().interrupt();}catch(IOException ignored){}} ,"worker-lease-deadline");watchdog.setDaemon(true);watchdog.start();
   try {check(SystemClock.elapsedRealtime()<challengeDeadline,"worker lease deadline");socket.connect(new LocalSocketAddress(endpoint.getPath(),LocalSocketAddress.Namespace.FILESYSTEM));Credentials peer=socket.getPeerCredentials();verifyBinding(owner,observed,peer.getUid(),peer.getPid(),bun,loader,loaderHash);socket.getOutputStream().write((new JSONObject().put("capability",capability).put("challenge",challenge).toString()+"\n").getBytes(StandardCharsets.UTF_8));socket.getOutputStream().flush();ByteArrayOutputStream response=new ByteArrayOutputStream();int b;
   while((b=responseStream.read())!=-1){check(response.size()<4096,"worker response exceeds bound");if(b=='\n')break;response.write(b);}check(b=='\n',"worker lease did not reply");JSONObject reply=new JSONObject(response.toString(StandardCharsets.UTF_8.name()));check(challenge.equals(reply.getString("challenge"))&&generation.equals(reply.getString("generation")),"worker lease challenge differs");check(!expired.get()&&SystemClock.elapsedRealtime()<challengeDeadline,"worker lease deadline");
   } finally {watchdog.interrupt();}
  }
  check(SystemClock.elapsedRealtime()<deadline,"worker inventory deadline");StructStat last=owned(journal,OsConstants.S_IFREG,0600),nowSource=owned(source,OsConstants.S_IFREG,0600),nowEndpoint=owned(endpoint,OsConstants.S_IFSOCK,0600);check(first.st_dev==last.st_dev&&first.st_ino==last.st_ino&&journalHash.equals(hash(journal,deadline)),"worker journal changed");check(sourceStat.st_dev==nowSource.st_dev&&sourceStat.st_ino==nowSource.st_ino&&sourceHash.equals(hash(source,deadline)),"worker source changed");check(endpointStat.st_dev==nowEndpoint.st_dev&&endpointStat.st_ino==nowEndpoint.st_ino,"worker endpoint changed");check(bunIdentity.equals(mappedBunIdentity(observed.pid,bun,deadline)),"mapped Bun changed after challenge");check(observed.key().equals(processIdentity(observed.pid,deadline).key()),"worker process changed after challenge");
 }
 static void verifyInventory(Map<Integer,Identity> before,Map<Integer,Identity> after,Set<Integer> verified,int self)throws Exception {
  check(before.containsKey(self)&&before.keySet().equals(after.keySet()),"same-UID process inventory changed");
  for(int pid:before.keySet()){check(pid==self||verified.contains(pid),"unregistered same-UID process; preserve it");check(before.get(pid).key().equals(after.get(pid).key()),"same-UID process identity changed");}
 }
 /** Invalid/stale durable journals never excuse a process; they also must not veto another proven worker. */
 private static JSONObject readableCandidate(File journal) {
  try {
   StructStat stat=owned(journal,OsConstants.S_IFREG,0600);
   check(stat.st_size<=16384,"worker journal too large");
   JSONObject owner=new JSONObject(new String(bounded(journal,16384),StandardCharsets.UTF_8));
   if(owner.getInt("schemaVersion")!=2 || owner.getInt("pid")<=0)return null;
   return owner;
  } catch(Exception unproven) {return null;} // Preserve evidence; unmatched live processes still refuse below.
 }
 interface CandidateVerifier { void verify(JSONObject owner,Identity observed)throws Exception; }
 /** Only positive authentication classifies a process; stale/malformed journals remain preserved. */
 static Set<Integer> classifyCandidates(Map<Integer,Identity> observed,List<JSONObject> candidates,int self,CandidateVerifier verifier)throws Exception {
  Set<Integer> verified=new HashSet<>();
  for(JSONObject owner:candidates) {
   int pid;
   try{if(owner==null||owner.getInt("schemaVersion")!=2)continue;pid=owner.getInt("pid");if(pid<=0||pid==self||!observed.containsKey(pid))continue;}
   catch(Exception unproven){continue;}
   try{verifier.verify(owner,observed.get(pid));}catch(Exception unproven){continue;}
   check(verified.add(pid),"ambiguous authenticated worker owner");
  }
  for(int pid:observed.keySet())check(pid==self||verified.contains(pid),"unregistered same-UID process; preserve it");
  return verified;
 }
 static void requireClassified(File suppliedHome,File suppliedState,File suppliedBun,File suppliedLoader)throws Exception {
  long deadline=SystemClock.elapsedRealtime()+10000;File home=suppliedHome.getCanonicalFile(),state=suppliedState.getCanonicalFile();owned(home,OsConstants.S_IFDIR,0700);check(state.equals(new File(home,".eliza/smthrs")),"unexpected workflow state scope");String bun=suppliedBun.getCanonicalPath(),loader=suppliedLoader.getCanonicalPath(),loaderHash=hash(new File(loader),deadline);Map<Integer,Identity> before=processes(deadline);Set<Integer> verified=new HashSet<>();
  if(before.size()>1){
   List<JSONObject> candidates=new ArrayList<>();Map<JSONObject,File> origins=new IdentityHashMap<>();
   for(File journal:journals(state)){JSONObject owner=readableCandidate(journal);if(owner!=null){candidates.add(owner);origins.put(owner,journal);}}
   verified=classifyCandidates(before,candidates,Process.myPid(),(owner,observed)->{
    check(SystemClock.elapsedRealtime()<deadline,"worker inventory deadline");
    verify(origins.get(owner),owner,observed,home,bun,loader,loaderHash,deadline);
   });
  }
  Map<Integer,Identity> after=processes(deadline);verifyInventory(before,after,verified,Process.myPid());check(SystemClock.elapsedRealtime()<deadline,"worker inventory deadline");
 }
}
