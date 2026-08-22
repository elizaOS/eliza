<#
.SYNOPSIS
  Owns deadline-wrapped Windows commands inside a kill-on-close Job Object.

.DESCRIPTION
  Creates the requested process suspended and atomically inside the Job
  Object. This keeper owns the completion/deadline race using the target's
  process handle and an absolute monotonic deadline. Exit 124 is emitted only
  after the job's active-process count reaches zero.
#>

[CmdletBinding()]
param(
  [Parameter(DontShow = $true)]
  [string] $TestOnlyExpireAfterCreatePidFile = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$commandSpecEnvironment = "ELIZA_RUN_WITH_DEADLINE_COMMAND_SPEC"
$jobDrainTimeoutMs = 8000
$jobPollIntervalMs = 25

function ConvertTo-NativeArgument {
  param([AllowEmptyString()][string] $Value)

  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }
  $quoted = '"'
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $backslashes += 1
      continue
    }
    if ($character -eq '"') {
      $quoted += (('\' * (2 * $backslashes + 1)) -join '') + '"'
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      $quoted += (('\' * $backslashes) -join '')
      $backslashes = 0
    }
    $quoted += $character
  }
  if ($backslashes -gt 0) {
    $quoted += (('\' * (2 * $backslashes)) -join '')
  }
  return $quoted + '"'
}

function Get-DeadlineRemainingMilliseconds {
  param([uint64] $DeadlineAtTickMs)

  $now = [RunWithDeadlineNative]::GetTickCount64()
  if ($now -ge $DeadlineAtTickMs) {
    return [uint32] 0
  }
  return [uint32] ($DeadlineAtTickMs - $now)
}

function Write-DeadlineMessage {
  param(
    [int64] $DeadlineMs,
    [string] $Command
  )

  $message = (
    '[run-with-deadline] wall-clock deadline of {0}ms exceeded; ' +
      'killing "{1}" process tree'
  ) -f $DeadlineMs, $Command
  [Console]::Error.WriteLine($message)
}

$nativeSource = @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class RunWithDeadlineNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodTotalUserTime;
    public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public IntPtr lpReserved;
    public IntPtr lpDesktop;
    public IntPtr lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateJobObject(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetInformationJobObject(
    IntPtr job,
    int informationClass,
    IntPtr information,
    uint informationLength
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool QueryInformationJobObject(
    IntPtr job,
    int informationClass,
    out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
    uint informationLength,
    IntPtr returnLength
  );

  public static uint GetActiveJobProcessCount(IntPtr job) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information;
    uint size = (uint)Marshal.SizeOf(
      typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
    );
    if (!QueryInformationJobObject(
      job,
      1,
      out information,
      size,
      IntPtr.Zero
    )) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    return information.ActiveProcesses;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool InitializeProcThreadAttributeList(
    IntPtr attributeList,
    int attributeCount,
    int flags,
    ref IntPtr size
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool UpdateProcThreadAttribute(
    IntPtr attributeList,
    uint flags,
    IntPtr attribute,
    IntPtr value,
    IntPtr size,
    IntPtr previousValue,
    IntPtr returnSize
  );

  [DllImport("kernel32.dll")]
  public static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcess(
    string applicationName,
    StringBuilder commandLine,
    IntPtr processAttributes,
    IntPtr threadAttributes,
    bool inheritHandles,
    uint creationFlags,
    IntPtr environment,
    IntPtr currentDirectory,
    ref STARTUPINFOEX startupInfo,
    out PROCESS_INFORMATION processInformation
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint ResumeThread(IntPtr thread);

  [DllImport("kernel32.dll")]
  public static extern ulong GetTickCount64();

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll")]
  public static extern IntPtr GetStdHandle(int standardHandle);

  [DllImport("kernel32.dll")]
  public static extern IntPtr GetCurrentProcess();

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool DuplicateHandle(
    IntPtr sourceProcess,
    IntPtr sourceHandle,
    IntPtr targetProcess,
    out IntPtr targetHandle,
    uint desiredAccess,
    bool inheritHandle,
    uint options
  );
}
"@

function Close-WorkerHandles {
  param([ref] $Information)

  $value = $Information.Value
  if ($value.hThread -ne [IntPtr]::Zero) {
    if (-not [RunWithDeadlineNative]::CloseHandle($value.hThread)) {
      throw [ComponentModel.Win32Exception]::new(
        [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      )
    }
    $value.hThread = [IntPtr]::Zero
    $Information.Value = $value
  }
  $value = $Information.Value
  if ($value.hProcess -ne [IntPtr]::Zero) {
    if (-not [RunWithDeadlineNative]::CloseHandle($value.hProcess)) {
      throw [ComponentModel.Win32Exception]::new(
        [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      )
    }
    $value.hProcess = [IntPtr]::Zero
    $Information.Value = $value
  }
}

function Wait-WindowsJobEmpty {
  param(
    [IntPtr] $Job,
    [int] $TimeoutMilliseconds
  )

  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    $active = [RunWithDeadlineNative]::GetActiveJobProcessCount($Job)
    if ($active -eq 0) {
      return
    }
    if ($watch.ElapsedMilliseconds -ge $TimeoutMilliseconds) {
      throw (
        "Windows Job Object did not drain within {0}ms; active={1}" -f
          $TimeoutMilliseconds,
          $active
      )
    }
    [Threading.Thread]::Sleep($jobPollIntervalMs)
  }
}

function Stop-WindowsJob {
  param(
    [IntPtr] $Job,
    [ref] $Information,
    [uint32] $ExitCode
  )

  if (-not [RunWithDeadlineNative]::TerminateJobObject($Job, $ExitCode)) {
    throw [ComponentModel.Win32Exception]::new(
      [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    )
  }
  Close-WorkerHandles $Information
  Wait-WindowsJobEmpty $Job $jobDrainTimeoutMs
}

$job = [IntPtr]::Zero
$attributeList = [IntPtr]::Zero
$jobPointer = [IntPtr]::Zero
$limitsPointer = [IntPtr]::Zero
$processInformation = $null
$inheritedStdInput = [IntPtr]::Zero
$inheritedStdOutput = [IntPtr]::Zero
$inheritedStdError = [IntPtr]::Zero
$nativeLoaded = $false
$startFailure = $false
$deadlineExpired = $false
$cleanupAttempted = $false
$command = "<unknown>"
$deadlineAtTickMs = [uint64] 0
$deadlineMs = [int64] 0
$exitCode = 1

try {
  $encodedSpec = [Environment]::GetEnvironmentVariable(
    $commandSpecEnvironment,
    "Process"
  )
  [Environment]::SetEnvironmentVariable(
    $commandSpecEnvironment,
    $null,
    "Process"
  )
  if ([String]::IsNullOrWhiteSpace($encodedSpec)) {
    throw "missing encoded command specification"
  }

  $specJson = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($encodedSpec)
  )
  $spec = ConvertFrom-Json $specJson
  $command = [string] $spec.command
  $deadlineAtTickMs = [uint64] $spec.deadlineAtTickMs
  $deadlineMs = [int64] $spec.deadlineMs
  if ([String]::IsNullOrWhiteSpace($command)) {
    throw "decoded command is empty"
  }
  if ($deadlineAtTickMs -le 0 -or $deadlineMs -le 0) {
    throw "decoded deadline is invalid"
  }

  Add-Type -TypeDefinition $nativeSource
  $nativeLoaded = $true
  $processInformation =
    New-Object RunWithDeadlineNative+PROCESS_INFORMATION
  if ((Get-DeadlineRemainingMilliseconds $deadlineAtTickMs) -eq 0) {
    $deadlineExpired = $true
    throw [TimeoutException]::new(
      "deadline expired before Windows setup"
    )
  }

  try {
    $resolvedCommand = Get-Command `
      $command `
      -CommandType Application `
      -ErrorAction Stop |
        Select-Object -First 1 -ExpandProperty Source
  } catch {
    # error-policy:J1 Command lookup failure maps to exit 127 unless the
    # helper observes that the wall-clock deadline already expired.
    $startFailure = $true
    throw (
      'failed to start Windows command "{0}": {1}' -f
        $command,
        $_.Exception.Message
    )
  }
  if ((Get-DeadlineRemainingMilliseconds $deadlineAtTickMs) -eq 0) {
    $deadlineExpired = $true
    throw [TimeoutException]::new(
      "deadline expired during command lookup"
    )
  }

  $nativeArguments = @()
  if ($null -ne $spec.args) {
    $nativeArguments = @($spec.args | ForEach-Object { [string] $_ })
  }
  $nativeCommandLine = @(
    ConvertTo-NativeArgument $resolvedCommand
    $nativeArguments | ForEach-Object { ConvertTo-NativeArgument $_ }
  ) -join ' '

  $job = [RunWithDeadlineNative]::CreateJobObject(
    [IntPtr]::Zero,
    $null
  )
  if ($job -eq [IntPtr]::Zero) {
    throw [ComponentModel.Win32Exception]::new(
      [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    )
  }

  $limits =
    New-Object RunWithDeadlineNative+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
  $basicLimits = $limits.BasicLimitInformation
  $basicLimits.LimitFlags = 0x00002000
  $limits.BasicLimitInformation = $basicLimits
  $limitsSize = [Runtime.InteropServices.Marshal]::SizeOf($limits)
  $limitsPointer =
    [Runtime.InteropServices.Marshal]::AllocHGlobal($limitsSize)
  [Runtime.InteropServices.Marshal]::StructureToPtr(
    $limits,
    $limitsPointer,
    $false
  )
  if (-not [RunWithDeadlineNative]::SetInformationJobObject(
    $job,
    9,
    $limitsPointer,
    $limitsSize
  )) {
    throw [ComponentModel.Win32Exception]::new(
      [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    )
  }

  $attributeSize = [IntPtr]::Zero
  [void] [RunWithDeadlineNative]::InitializeProcThreadAttributeList(
    [IntPtr]::Zero,
    1,
    0,
    [ref] $attributeSize
  )
  $attributeList =
    [Runtime.InteropServices.Marshal]::AllocHGlobal($attributeSize)
  if (-not [RunWithDeadlineNative]::InitializeProcThreadAttributeList(
    $attributeList,
    1,
    0,
    [ref] $attributeSize
  )) {
    throw [ComponentModel.Win32Exception]::new(
      [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    )
  }

  $jobPointer = [Runtime.InteropServices.Marshal]::AllocHGlobal(
    [IntPtr]::Size
  )
  [Runtime.InteropServices.Marshal]::WriteIntPtr($jobPointer, $job)
  if (-not [RunWithDeadlineNative]::UpdateProcThreadAttribute(
    $attributeList,
    0,
    [IntPtr] 0x0002000D,
    $jobPointer,
    [IntPtr] [IntPtr]::Size,
    [IntPtr]::Zero,
    [IntPtr]::Zero
  )) {
    throw [ComponentModel.Win32Exception]::new(
      [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    )
  }
  if ((Get-DeadlineRemainingMilliseconds $deadlineAtTickMs) -eq 0) {
    $deadlineExpired = $true
    throw [TimeoutException]::new(
      "deadline expired before process creation"
    )
  }

  $workerCommand = [Text.StringBuilder]::new($nativeCommandLine)
  $startupInfo = New-Object RunWithDeadlineNative+STARTUPINFOEX
  $baseStartupInfo = $startupInfo.StartupInfo
  $baseStartupInfo.cb = [Runtime.InteropServices.Marshal]::SizeOf(
    $startupInfo
  )
  $baseStartupInfo.dwFlags = 0x00000100
  $currentProcess = [RunWithDeadlineNative]::GetCurrentProcess()
  if (-not [RunWithDeadlineNative]::DuplicateHandle(
    $currentProcess,
    [RunWithDeadlineNative]::GetStdHandle(-10),
    $currentProcess,
    [ref] $inheritedStdInput,
    0,
    $true,
    2
  )) {
    $nativeError = [ComponentModel.Win32Exception]::new(
      [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    )
    throw "stdin handle duplication failed: $($nativeError.Message)"
  }
  if (-not [RunWithDeadlineNative]::DuplicateHandle(
    $currentProcess,
    [RunWithDeadlineNative]::GetStdHandle(-11),
    $currentProcess,
    [ref] $inheritedStdOutput,
    0,
    $true,
    2
  )) {
    $nativeError = [ComponentModel.Win32Exception]::new(
      [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    )
    throw "stdout handle duplication failed: $($nativeError.Message)"
  }
  if (-not [RunWithDeadlineNative]::DuplicateHandle(
    $currentProcess,
    [RunWithDeadlineNative]::GetStdHandle(-12),
    $currentProcess,
    [ref] $inheritedStdError,
    0,
    $true,
    2
  )) {
    $nativeError = [ComponentModel.Win32Exception]::new(
      [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    )
    throw "stderr handle duplication failed: $($nativeError.Message)"
  }
  $baseStartupInfo.hStdInput = $inheritedStdInput
  $baseStartupInfo.hStdOutput = $inheritedStdOutput
  $baseStartupInfo.hStdError = $inheritedStdError
  $startupInfo.StartupInfo = $baseStartupInfo
  $startupInfo.lpAttributeList = $attributeList

  if (-not [RunWithDeadlineNative]::CreateProcess(
    $resolvedCommand,
    $workerCommand,
    [IntPtr]::Zero,
    [IntPtr]::Zero,
    $true,
    0x00080004,
    [IntPtr]::Zero,
    [IntPtr]::Zero,
    [ref] $startupInfo,
    [ref] $processInformation
  )) {
    $startFailure = $true
    $nativeError = [ComponentModel.Win32Exception]::new(
      [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    )
    throw (
      'failed to start Windows command "{0}": {1}' -f
        $command,
        $nativeError.Message
    )
  }

  [void] [RunWithDeadlineNative]::CloseHandle($inheritedStdInput)
  [void] [RunWithDeadlineNative]::CloseHandle($inheritedStdOutput)
  [void] [RunWithDeadlineNative]::CloseHandle($inheritedStdError)
  $inheritedStdInput = [IntPtr]::Zero
  $inheritedStdOutput = [IntPtr]::Zero
  $inheritedStdError = [IntPtr]::Zero

  # The production wrapper never supplies this focused fault-injection
  # parameter. Direct helper tests use it to prove that a target created
  # suspended is reaped without executing when the deadline wins here.
  if (-not [String]::IsNullOrEmpty($TestOnlyExpireAfterCreatePidFile)) {
    [IO.File]::WriteAllText(
      $TestOnlyExpireAfterCreatePidFile,
      [string] $processInformation.dwProcessId
    )
    $deadlineAtTickMs = [RunWithDeadlineNative]::GetTickCount64()
  }

  if ((Get-DeadlineRemainingMilliseconds $deadlineAtTickMs) -eq 0) {
    $deadlineExpired = $true
    throw [TimeoutException]::new(
      "deadline expired before process resume"
    )
  }
  $previousSuspendCount = [RunWithDeadlineNative]::ResumeThread(
    $processInformation.hThread
  )
  if ($previousSuspendCount -eq [uint32]::MaxValue) {
    $startFailure = $true
    throw [ComponentModel.Win32Exception]::new(
      [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    )
  }
  if ($previousSuspendCount -ne 1) {
    throw (
      "unexpected primary-thread suspend count: " +
        $previousSuspendCount
    )
  }

  $workerHandles = $processInformation
  if (-not [RunWithDeadlineNative]::CloseHandle(
    $workerHandles.hThread
  )) {
    throw [ComponentModel.Win32Exception]::new(
      [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    )
  }
  $workerHandles.hThread = [IntPtr]::Zero
  $processInformation = $workerHandles

  while ($true) {
    $remainingMs = Get-DeadlineRemainingMilliseconds $deadlineAtTickMs
    if ($remainingMs -eq 0) {
      $deadlineExpired = $true
      throw [TimeoutException]::new("Windows process deadline expired")
    }
    $waitSliceMs = [uint32] [Math]::Min(
      [uint32] $jobPollIntervalMs,
      [uint32] $remainingMs
    )
    $waitResult = [RunWithDeadlineNative]::WaitForSingleObject(
      $processInformation.hProcess,
      $waitSliceMs
    )
    if ($waitResult -eq 0) {
      break
    }
    if ($waitResult -ne 258) {
      throw "unexpected Windows worker wait result: $waitResult"
    }
  }

  [uint32] $workerExitCode = 0
  if (-not [RunWithDeadlineNative]::GetExitCodeProcess(
    $processInformation.hProcess,
    [ref] $workerExitCode
  )) {
    throw [ComponentModel.Win32Exception]::new(
      [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    )
  }
  $cleanupAttempted = $true
  Stop-WindowsJob $job ([ref] $processInformation) $workerExitCode
  $exitCode = [BitConverter]::ToInt32(
    [BitConverter]::GetBytes($workerExitCode),
    0
  )
} catch {
  # error-policy:J1 The keeper translates start failures, deadlines, and
  # internal errors only after any owned Job Object is proven empty.
  $primaryError = $_.Exception
  if (
    $startFailure -and
    $deadlineAtTickMs -gt 0 -and
    (Get-DeadlineRemainingMilliseconds $deadlineAtTickMs) -eq 0
  ) {
    $deadlineExpired = $true
  }

  $cleanupError = if ($cleanupAttempted) {
    $primaryError
  } else {
    $null
  }
  if (
    -not $cleanupAttempted -and
    $nativeLoaded -and
    $job -ne [IntPtr]::Zero
  ) {
    $cleanupAttempted = $true
    $cleanupExitCode = if ($deadlineExpired) {
      [uint32] 124
    } else {
      [uint32] 1
    }
    try {
      Stop-WindowsJob $job ([ref] $processInformation) $cleanupExitCode
    } catch {
      # error-policy:J1 Failure to prove an empty Job Object overrides every
      # claimed outcome, including a deadline.
      $cleanupError = $_.Exception
    }
  }

  if ($null -ne $cleanupError) {
    [Console]::Error.WriteLine(
      "[run-with-deadline] Windows job cleanup failed: " +
        $cleanupError.Message
    )
    $exitCode = 1
  } elseif ($deadlineExpired) {
    Write-DeadlineMessage $deadlineMs $command
    $exitCode = 124
  } elseif ($startFailure) {
    [Console]::Error.WriteLine(
      "[run-with-deadline] Windows job supervisor failed: " +
        $primaryError.Message
    )
    $exitCode = 127
  } else {
    [Console]::Error.WriteLine(
      "[run-with-deadline] Windows job supervisor failed: " +
        $primaryError.Message
    )
    $exitCode = 1
  }
} finally {
  if ($nativeLoaded -and $null -ne $processInformation) {
    try {
      Close-WorkerHandles ([ref] $processInformation)
    } catch {
      # error-policy:J6 Final handle closure is best effort after the exit
      # result is fixed; kill-on-close still protects any retained job members.
    }
  }
  if (
    $nativeLoaded -and
    $inheritedStdInput -ne [IntPtr]::Zero
  ) {
    [void] [RunWithDeadlineNative]::CloseHandle($inheritedStdInput)
  }
  if (
    $nativeLoaded -and
    $inheritedStdOutput -ne [IntPtr]::Zero
  ) {
    [void] [RunWithDeadlineNative]::CloseHandle($inheritedStdOutput)
  }
  if (
    $nativeLoaded -and
    $inheritedStdError -ne [IntPtr]::Zero
  ) {
    [void] [RunWithDeadlineNative]::CloseHandle($inheritedStdError)
  }
  if ($nativeLoaded -and $attributeList -ne [IntPtr]::Zero) {
    [RunWithDeadlineNative]::DeleteProcThreadAttributeList($attributeList)
  }
  if ($jobPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($jobPointer)
  }
  if ($limitsPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($limitsPointer)
  }
  if ($attributeList -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($attributeList)
  }
  if ($nativeLoaded -and $job -ne [IntPtr]::Zero) {
    [void] [RunWithDeadlineNative]::CloseHandle($job)
  }
}

exit $exitCode
