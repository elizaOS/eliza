// Native Windows lease security primitives; exercised by the Windows acceptance lane.
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

public static class WindowsLeaseNative {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public int inherit; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text,uint revision,out IntPtr descriptor,out uint length);
  [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetSecurityInfo(IntPtr h,int kind,uint fields,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafePipeHandle CreateNamedPipe(string name,uint openMode,uint pipeMode,uint instances,uint outSize,uint inSize,uint timeout,ref SA security);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,out uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe,out uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern SafeProcessHandle OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(SafeProcessHandle process,uint access,out SafeFileHandle token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(SafeFileHandle token,int kind,IntPtr buffer,uint length,out uint needed);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(SafeProcessHandle process,out long created,out long exit,out long kernel,out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool MoveFileEx(string from,string to,uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,ref SA security,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle file);
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME created, accessed, written;
    public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out FileInfo info);
  public sealed class DirectoryChain : IDisposable {
    readonly System.Collections.Generic.List<SafeFileHandle> handles=new System.Collections.Generic.List<SafeFileHandle>();
    public void Dispose(){for(int n=handles.Count-1;n>=0;n--)handles[n].Dispose();handles.Clear();}
    internal void Add(SafeFileHandle h){handles.Add(h);}
  }
  public static DirectoryChain LockPrivateDirectory(string directory) {return LockDirectory(directory,true);}
  static DirectoryChain LockDirectory(string directory,bool requirePrivate) {
    // Local drive paths only; reject UNC, device paths, alternate streams and lexical aliases.
    string full=Path.GetFullPath(directory);
    if(!System.Text.RegularExpressions.Regex.IsMatch(full,@"^[A-Za-z]:\\") || full.Substring(2).Contains(":"))throw new ArgumentException("Local drive path required");
    if(!String.Equals(full.TrimEnd('\\'),directory.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase))throw new ArgumentException("Canonical path required");
    var chain=new DirectoryChain();
    try {
      string current=Path.GetPathRoot(full);
      var parts=full.Substring(current.Length).Split(new[]{'\\'},StringSplitOptions.RemoveEmptyEntries);
      for(int n=-1;n<parts.Length;n++) {
        if(n>=0)current=Path.Combine(current,parts[n]);
        var sa=new SA{length=Marshal.SizeOf(typeof(SA))};
        // READ_CONTROL | READ_ATTRIBUTES, shared READ/WRITE but NOT DELETE pins each ancestor identity.
        var handle=CreateFile(current,(n==parts.Length-1 && !requirePrivate)?0x60080u:0x20080u,3,ref sa,3,0x02000000|0x00200000,IntPtr.Zero);
        if(handle.IsInvalid){handle.Dispose();throw Error("Pin directory ancestor");}
        chain.Add(handle);FileInfo info;
        if(!GetFileInformationByHandle(handle,out info))throw Error("Directory identity");
        if((info.attributes&0x10)==0 || (info.attributes&0x400)!=0)throw new InvalidOperationException("Non-directory or reparse ancestor");
        if(n==parts.Length-1 && requirePrivate)VerifyPrivateHandle(handle.DangerousGetHandle());
      }
      return chain;
    } catch {chain.Dispose();throw;}
  }
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetKernelObjectSecurity(IntPtr handle,uint fields,IntPtr descriptor);
  static bool ValidateStateOwnerAndAcl(IntPtr handle) {
    IntPtr owner,group,dacl,sacl,old;uint error=GetSecurityInfo(handle,1,5,out owner,out group,out dacl,out sacl,out old);
    if(error!=0)throw new Win32Exception((int)error);
    try {
      if(dacl==IntPtr.Zero)throw new InvalidOperationException("Null state DACL");
      uint length=GetSecurityDescriptorLength(old);if(length==0||length>65536)throw new InvalidOperationException("State ACL length");byte[] bytes=new byte[length];Marshal.Copy(old,bytes,0,bytes.Length);
      var acl=new RawSecurityDescriptor(bytes,0);string sid=CurrentSid();
      bool administratorOwner=acl.Owner!=null&&acl.Owner.Value=="S-1-5-32-544";
      using(var identity=WindowsIdentity.GetCurrent()) {
        if(acl.Owner==null||(acl.Owner.Value!=sid&&!(administratorOwner&&new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))))throw new InvalidOperationException("Wrong state SID");
      }
      foreach(GenericAce entry in acl.DiscretionaryAcl){var rule=entry as CommonAce;if(rule==null||rule.IsCallback||(rule.SecurityIdentifier.Value!=sid&&rule.SecurityIdentifier.Value!="S-1-5-18"&&rule.SecurityIdentifier.Value!="S-1-5-32-544"))throw new InvalidOperationException("Untrusted existing state ACL");}
      return administratorOwner;
    } finally {LocalFree(old);}
  }
  static void ApplyPrivateState(IntPtr handle,bool normalizeOwner) {
    IntPtr sd=Descriptor();try {if(!SetKernelObjectSecurity(handle,(normalizeOwner?5u:4u)|0x80000000u,sd))throw Error("Protect state DACL");}finally{LocalFree(sd);}
    VerifyPrivateHandle(handle);
  }
  public static void ProtectExistingDirectory(string directory) {
    using(LockDirectory(directory,false)) {
      var sa=new SA{length=Marshal.SizeOf(typeof(SA))};
      // Current-SID directories need their original READ_CONTROL/WRITE_DAC rights only.
      using(var handle=CreateFile(directory,0x60080,3,ref sa,3,0x02000000|0x00200000,IntPtr.Zero)) {
        if(handle.IsInvalid)throw Error("State ACL handle");
        if(!ValidateStateOwnerAndAcl(handle.DangerousGetHandle())) {
          ApplyPrivateState(handle.DangerousGetHandle(),false);
          return;
        }
        // Only the validated enabled-administrator case requests WRITE_OWNER.
        // Keep original handle and ancestor no-delete pins while opening the mutation handle.
        FileInfo original;if(!GetFileInformationByHandle(handle,out original))throw Error("State directory identity");
        using(var ownerHandle=CreateFile(directory,0xE0080,3,ref sa,3,0x02000000|0x00200000,IntPtr.Zero)) {
          if(ownerHandle.IsInvalid)throw Error("State owner handle");
          FileInfo current;if(!GetFileInformationByHandle(ownerHandle,out current))throw Error("State owner identity");
          if(original.volume!=current.volume||original.indexHigh!=current.indexHigh||original.indexLow!=current.indexLow||(current.attributes&0x10)==0||(current.attributes&0x400)!=0)throw new InvalidOperationException("State directory changed");
          if(!ValidateStateOwnerAndAcl(ownerHandle.DangerousGetHandle()))throw new InvalidOperationException("State owner changed");
          ApplyPrivateState(ownerHandle.DangerousGetHandle(),true);
        }
      }
    }
  }
  public static byte[] ReadPrivateFile(string file,int maximum) {
    using(LockPrivateDirectory(Path.GetDirectoryName(file))) {
      var sa=new SA{length=Marshal.SizeOf(typeof(SA))};
      using(var handle=CreateFile(file,0x80020000,1,ref sa,3,0x00200000,IntPtr.Zero)) {
        if(handle.IsInvalid)throw Error("Read private file");FileInfo info;
        if(!GetFileInformationByHandle(handle,out info))throw Error("Private file identity");
        if((info.attributes&(0x10|0x400))!=0 || info.sizeHigh!=0 || info.sizeLow>maximum)throw new InvalidOperationException("Invalid private file");
        VerifyPrivateHandle(handle.DangerousGetHandle());
        using(var stream=new FileStream(handle,FileAccess.Read)){byte[] bytes=new byte[info.sizeLow];int offset=0;while(offset<bytes.Length){int n=stream.Read(bytes,offset,bytes.Length-offset);if(n==0)throw new EndOfStreamException();offset+=n;}return bytes;}
      }
    }
  }
  public static void PublishImmutableSource(string target,byte[] source) {
    if(source.Length>10*1024*1024)throw new ArgumentException("Source size");
    using(LockPrivateDirectory(Path.GetDirectoryName(target))) {
      string temporary=target+"."+Guid.NewGuid().ToString("N")+".pending";
      WriteNewPrivateFile(temporary,source);
      try {
        try {PublishNoReplace(temporary,target);} catch(Win32Exception e){if(e.NativeErrorCode!=80 && e.NativeErrorCode!=183)throw;}
        byte[] actual=ReadPrivateFile(target,10*1024*1024);
        if(actual.Length!=source.Length)throw new InvalidOperationException("Source identity mismatch");
        for(int n=0;n<source.Length;n++)if(actual[n]!=source[n])throw new InvalidOperationException("Source identity mismatch");
      } finally {if(File.Exists(temporary))File.Delete(temporary);}
    }
  }
  public static long ProcessBirth(uint pid) {
    using(var h=OpenProcess(0x1000,false,pid)){if(h.IsInvalid)throw Error("Process identity");long a,b,c,d;if(!GetProcessTimes(h,out a,out b,out c,out d))throw Error("Process times");return a;}
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CancelIoEx(SafePipeHandle pipe,IntPtr overlapped);
  static async System.Threading.Tasks.Task<T> Bound<T>(System.Threading.Tasks.Task<T> work,IDisposable resource,int milliseconds) {
    var winner=await System.Threading.Tasks.Task.WhenAny(work,System.Threading.Tasks.Task.Delay(milliseconds));
    if(winner!=work){var pipe=resource as System.IO.Pipes.PipeStream;if(pipe!=null){CancelIoEx(pipe.SafePipeHandle,IntPtr.Zero);if(await System.Threading.Tasks.Task.WhenAny(work,System.Threading.Tasks.Task.Delay(1000))!=work)resource.Dispose();}else resource.Dispose();var observed=work.ContinueWith(t=>{var ignored=t.Exception;},System.Threading.Tasks.TaskContinuationOptions.OnlyOnFaulted);throw new TimeoutException("Named pipe deadline");}
    return await work;
  }
  static async System.Threading.Tasks.Task<string> Line(System.IO.Pipes.PipeStream stream) {
    using(var bytes=new MemoryStream()) {byte[] one=new byte[1];while(bytes.Length<4096){int n=await Bound(stream.ReadAsync(one,0,1),stream,1000);if(n==0)throw new EndOfStreamException();if(one[0]==10)return new System.Text.UTF8Encoding(false,true).GetString(bytes.ToArray());bytes.WriteByte(one[0]);}throw new InvalidDataException("Pipe frame too large");}
  }
  static async System.Threading.Tasks.Task<bool> Send(System.IO.Pipes.PipeStream stream,string text) {
    byte[] bytes=System.Text.Encoding.UTF8.GetBytes(text+"\n");if(bytes.Length>4096)throw new InvalidDataException("Pipe frame too large");await stream.WriteAsync(bytes,0,bytes.Length);return true;
  }
  static bool Hex(string text,int count){return text!=null && System.Text.RegularExpressions.Regex.IsMatch(text,"^[a-f0-9]{"+count+"}$");}
  public static async System.Threading.Tasks.Task<string> Probe(string name,uint pid,long created,string capability,string generation) {
    if(!Hex(capability,64)||!Hex(generation,32)||!System.Text.RegularExpressions.Regex.IsMatch(name,@"^eliza-workflow-[a-f0-9]{64}$"))throw new ArgumentException("Probe identity");
    var sa=new SA{length=Marshal.SizeOf(typeof(SA))};
    // SQOS identification prevents an untrusted server from impersonating this caller.
    using(var file=CreateFile(@"\\.\pipe\"+name,0xC0020000,0,ref sa,3,0x40000000|0x00100000|0x00010000,IntPtr.Zero)) {
      if(file.IsInvalid)throw Error("Connect lease pipe");
      using(var pipe=new SafePipeHandle(file.DangerousGetHandle(),false)) {
        VerifyPrivateHandle(pipe.DangerousGetHandle());VerifyPeer(pipe,true,pid,created);
        using(var stream=new System.IO.Pipes.NamedPipeClientStream(System.IO.Pipes.PipeDirection.InOut,true,true,pipe)) {
          string challenge=Guid.NewGuid().ToString("N");await Bound(Send(stream,capability+":"+challenge),stream,1000);
          string response=await Bound(Line(stream),stream,1000);
          if(response!=generation+":"+challenge)throw new InvalidDataException("Worker challenge mismatch");
          await Bound(Send(stream,"ack:"+challenge),stream,1000);return generation;
        }
      }
    }
  }
  public static async System.Threading.Tasks.Task Serve(string name,string capability,string generation,uint workerPid,long workerBirth,System.Threading.CancellationToken stop) {
    if(!Hex(capability,64)||!Hex(generation,32)||ProcessBirth(workerPid)!=workerBirth)throw new ArgumentException("Worker identity");
    using(var handle=CreatePrivatePipe(name))
    using(var stream=new System.IO.Pipes.NamedPipeServerStream(System.IO.Pipes.PipeDirection.InOut,true,false,handle)) {
      // Lifetime monitor must stop without deleting the durable reservation on worker exit.
      while(!stop.IsCancellationRequested) {
        var accept=stream.WaitForConnectionAsync();
        while(!accept.IsCompleted) {
          if(stop.IsCancellationRequested || ProcessBirth(workerPid)!=workerBirth){stream.Dispose();try{await accept;}catch{}return;}
          await System.Threading.Tasks.Task.WhenAny(accept,System.Threading.Tasks.Task.Delay(100));
        }
        await accept;
        try {
          uint peer;if(!GetNamedPipeClientProcessId(handle,out peer))throw Error("Client identity");VerifyPeer(handle,false,peer,ProcessBirth(peer));
          string frame=await Bound(Line(stream),stream,1000);string[] fields=frame.Split(':');
          if(fields.Length!=2||!Hex(fields[0],64)||!Hex(fields[1],32))throw new InvalidDataException("Challenge frame");
          int difference=0;for(int n=0;n<64;n++)difference|=fields[0][n]^capability[n];if(difference!=0)throw new InvalidDataException("Capability mismatch");
          await Bound(Send(stream,generation+":"+fields[1]),stream,1000);
          // DisconnectNamedPipe discards unread bytes. Keep the response alive
          // until the authenticated client acknowledges consumption, bounded
          // like every other frame so a stalled client cannot hold the lease.
          string acknowledgement=await Bound(Line(stream),stream,1000);
          if(acknowledgement!="ack:"+fields[1])throw new InvalidDataException("Challenge acknowledgement");
        } catch(EndOfStreamException) { /* A probe can disconnect before sending; keep the original generation. */
        } catch(InvalidDataException) { /* Reject this bounded frame without retiring the lease. */
        } catch(TimeoutException) { /* CancelIoEx settled the pending I/O; retain the original pipe instance. */
        } finally {if(stream.IsConnected)stream.Disconnect();}
      }
    }
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFileAttributes(string path);
  public static bool EntryExists(string path) {
    uint attributes=GetFileAttributes(path);if(attributes!=0xffffffff)return true;
    int error=Marshal.GetLastWin32Error();if(error==2)return false;throw new Win32Exception(error,"Lease entry visibility");
  }
  static Exception Error(string operation) {return new Win32Exception(Marshal.GetLastWin32Error(),operation);}
  public static string CurrentSid() {
    using(var identity=WindowsIdentity.GetCurrent()) { if(identity.User==null) throw new InvalidOperationException("Missing current SID"); return identity.User.Value; }
  }
  static IntPtr Descriptor() {
    IntPtr sd;uint size;
    // No inherited/default/Everyone/anonymous rights. SYSTEM is an explicit trusted OS principal.
    string sid=CurrentSid();
    if(!ConvertStringSecurityDescriptorToSecurityDescriptor("O:"+sid+"D:P(A;;FA;;;"+sid+")(A;;FA;;;SY)",1,out sd,out size)) throw Error("Security descriptor");
    return sd;
  }
  public static void VerifyPrivateHandle(IntPtr handle) {
    IntPtr owner,group,dacl,sacl,sd;uint error=GetSecurityInfo(handle,1,5,out owner,out group,out dacl,out sacl,out sd);
    if(error!=0) throw new Win32Exception((int)error,"GetSecurityInfo");
    try {
      if(dacl==IntPtr.Zero) throw new InvalidOperationException("Null DACL");
      uint length=GetSecurityDescriptorLength(sd);if(length==0 || length>65536) throw new InvalidOperationException("Security descriptor size");
      byte[] bytes=new byte[length];Marshal.Copy(sd,bytes,0,bytes.Length);
      var descriptor=new RawSecurityDescriptor(bytes,0);string sid=CurrentSid();
      if(descriptor.Owner==null || descriptor.Owner.Value!=sid || (descriptor.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0 || descriptor.DiscretionaryAcl==null) throw new InvalidOperationException("Untrusted owner/ACL");
      bool userRule=false;
      foreach(GenericAce ace in descriptor.DiscretionaryAcl) {
        var access=ace as CommonAce;
        if(access==null || access.IsCallback || access.AceQualifier!=AceQualifier.AccessAllowed || (access.AceFlags&AceFlags.Inherited)!=0 || (access.SecurityIdentifier.Value!=sid && access.SecurityIdentifier.Value!="S-1-5-18")) throw new InvalidOperationException("Unexpected ACL principal or rule");
        if(access.SecurityIdentifier.Value==sid) userRule=true;
      }
      if(!userRule) throw new InvalidOperationException("Current SID access absent");
    } finally {LocalFree(sd);}
  }
  public static SafePipeHandle CreatePrivatePipe(string name) {
    if(!System.Text.RegularExpressions.Regex.IsMatch(name,@"^eliza-workflow-[a-f0-9]{64}$")) throw new ArgumentException("Pipe name");
    IntPtr sd=Descriptor();
    try {
      var sa=new SA{length=Marshal.SizeOf(typeof(SA)),descriptor=sd,inherit=0};
      // DUPLEX | FIRST_PIPE_INSTANCE | OVERLAPPED; byte stream; reject remote clients; one instance.
      var handle=CreateNamedPipe(@"\\.\pipe\"+name,3|0x00080000|0x40000000,8,1,4096,4096,1000,ref sa);
      if(handle.IsInvalid){handle.Dispose();throw Error("CreateNamedPipe");}
      try {VerifyPrivateHandle(handle.DangerousGetHandle());return handle;} catch {handle.Dispose();throw;}
    } finally {LocalFree(sd);}
  }
  // Call BEFORE sending any capability. PID plus creation time and token SID prevent PID-only authentication.
  public static void VerifyPeer(SafePipeHandle pipe,bool server,uint expectedPid,long expectedCreated) {
    uint pid; bool ok=server?GetNamedPipeServerProcessId(pipe,out pid):GetNamedPipeClientProcessId(pipe,out pid);
    if(!ok) throw Error("Named pipe peer PID");
    if(pid!=expectedPid) throw new InvalidOperationException("Wrong peer PID");
    using(var process=OpenProcess(0x1000,false,pid)) {
      if(process.IsInvalid) throw Error("Peer process");
      long created,exited,kernel,user;if(!GetProcessTimes(process,out created,out exited,out kernel,out user))throw Error("Peer creation time");
      if(created!=expectedCreated)throw new InvalidOperationException("Peer PID generation changed");
      SafeFileHandle token;if(!OpenProcessToken(process,8,out token))throw Error("Peer token");
      using(token){uint needed;GetTokenInformation(token,1,IntPtr.Zero,0,out needed);if(needed==0||needed>65536)throw new InvalidOperationException("Token size");
        IntPtr buffer=Marshal.AllocHGlobal((int)needed);try {
          if(!GetTokenInformation(token,1,buffer,needed,out needed))throw Error("TokenUser");
          var sid=new SecurityIdentifier(Marshal.ReadIntPtr(buffer));if(sid.Value!=CurrentSid())throw new InvalidOperationException("Wrong peer SID");
        } finally {Marshal.FreeHGlobal(buffer);}
      }
    }
  }
  // Caller MUST hold the verified non-reparse parent chain against rename/replacement before using paths.
  // This primitive deliberately does not claim that path-based validation alone establishes that precondition.
  public static void WriteNewPrivateFile(string temporary,byte[] bytes) {
    IntPtr sd=Descriptor();try {
      var sa=new SA{length=Marshal.SizeOf(typeof(SA)),descriptor=sd,inherit=0};
      using(var handle=CreateFile(temporary,0xC0000000,1,ref sa,1,0x80000000|0x00200000,IntPtr.Zero)) {
        if(handle.IsInvalid)throw Error("CREATE_NEW private file");VerifyPrivateHandle(handle.DangerousGetHandle());
        using(var stream=new FileStream(handle,FileAccess.ReadWrite)){stream.Write(bytes,0,bytes.Length);stream.Flush();if(!FlushFileBuffers(handle))throw Error("FlushFileBuffers");}
      }
    } finally {LocalFree(sd);}
  }
  public static void PublishNoReplace(string temporary,string target) {
    // No COPY_ALLOWED or REPLACE_EXISTING: same-volume publication fails on any existing target.
    if(!MoveFileEx(temporary,target,8))throw Error("Immutable publication");
  }
}
