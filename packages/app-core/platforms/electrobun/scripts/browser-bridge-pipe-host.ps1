# Creates the Windows browser broker pipe with its security descriptor at creation time.
param(
  [Parameter(Mandatory = $true)][string]$PipeName,
  [switch]$ContractProbe
)
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace ElizaBrowserBridge {
  public static class SecurePipeFactory {
    private const uint PIPE_ACCESS_DUPLEX = 0x00000003;
    private const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
    private const uint PIPE_TYPE_BYTE = 0x00000000;
    private const uint PIPE_READMODE_BYTE = 0x00000000;
    private const uint PIPE_WAIT = 0x00000000;
    // CreateNamedPipe must receive this bit; PipeOptions.CurrentUserOnly does not set it.
    private const uint PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;

    public static string Contract() {
      return "CreateNamedPipeW|PIPE_REJECT_REMOTE_CLIENTS|FIRST_INSTANCE|USER_AND_LOGON_SID_DACL";
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES {
      public int nLength;
      public IntPtr lpSecurityDescriptor;
      public int bInheritHandle;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafePipeHandle CreateNamedPipeW(
      string lpName,
      uint dwOpenMode,
      uint dwPipeMode,
      uint nMaxInstances,
      uint nOutBufferSize,
      uint nInBufferSize,
      uint nDefaultTimeOut,
      ref SECURITY_ATTRIBUTES lpSecurityAttributes
    );

    public static NamedPipeServerStream Create(string pipeName) {
      if (String.IsNullOrWhiteSpace(pipeName) || pipeName.Contains("\\")) {
        throw new ArgumentException("invalid pipe name");
      }
      using (WindowsIdentity identity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query)) {
        SecurityIdentifier userSid = identity.User;
        SecurityIdentifier logonSid = null;
        if (userSid == null) throw new InvalidOperationException("current-user SID unavailable");
        foreach (IdentityReference group in identity.Groups) {
          SecurityIdentifier sid = group as SecurityIdentifier;
          if (sid != null && sid.Value.StartsWith("S-1-5-5-", StringComparison.Ordinal)) {
            logonSid = sid;
            break;
          }
        }
        if (logonSid == null) throw new InvalidOperationException("logon SID unavailable");
        string sddl = "O:" + userSid.Value + "G:" + userSid.Value +
          "D:P(A;;GA;;;SY)(A;;GA;;;" + userSid.Value + ")" +
          "(A;;GA;;;" + logonSid.Value + ")";
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor(sddl);
        byte[] descriptorBytes = new byte[descriptor.BinaryLength];
        descriptor.GetBinaryForm(descriptorBytes, 0);
        GCHandle pinned = GCHandle.Alloc(descriptorBytes, GCHandleType.Pinned);
        try {
          SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES();
          attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
          attributes.lpSecurityDescriptor = pinned.AddrOfPinnedObject();
          attributes.bInheritHandle = 0;
          SafePipeHandle handle = CreateNamedPipeW(
            @"\\.\pipe\" + pipeName,
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            65536,
            65536,
            0,
            ref attributes
          );
          if (handle == null || handle.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            if (handle != null) handle.Dispose();
            throw new Win32Exception(error, "secure CreateNamedPipeW failed");
          }
          return new NamedPipeServerStream(PipeDirection.InOut, false, false, handle);
        } finally {
          pinned.Free();
        }
      }
    }
  }
}
'@
if ($ContractProbe) {
  [Console]::Out.Write([ElizaBrowserBridge.SecurePipeFactory]::Contract())
  exit 0
}
$pipe = [ElizaBrowserBridge.SecurePipeFactory]::Create($PipeName)
[Console]::Error.WriteLine("READY")
$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()
function Read-Exact([System.IO.Stream]$stream, [int]$count) {
  $buffer = [byte[]]::new($count)
  $offset = 0
  while ($offset -lt $count) {
    $read = $stream.Read($buffer, $offset, $count - $offset)
    if ($read -eq 0) { throw "stream closed" }
    $offset += $read
  }
  return $buffer
}
while ($true) {
  $pipe.WaitForConnection()
  try {
    $header = Read-Exact $pipe 4
    $length = [BitConverter]::ToUInt32($header, 0)
    if ($length -eq 0 -or $length -gt 65536) { throw "invalid frame" }
    $body = Read-Exact $pipe $length
    $stdout.Write($header, 0, 4)
    $stdout.Write($body, 0, $body.Length)
    $stdout.Flush()
    $responseHeader = Read-Exact $stdin 4
    $responseLength = [BitConverter]::ToUInt32($responseHeader, 0)
    if ($responseLength -eq 0 -or $responseLength -gt 65536) { throw "invalid response frame" }
    $responseBody = Read-Exact $stdin $responseLength
    $pipe.Write($responseHeader, 0, 4)
    $pipe.Write($responseBody, 0, $responseBody.Length)
    $pipe.Flush()
  } finally {
    if ($pipe.IsConnected) { $pipe.Disconnect() }
  }
}
