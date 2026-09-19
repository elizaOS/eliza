/**
 * Owns the complete Windows staging proof process tree. Closing the job kills
 * descendants even if their PowerShell parent has already exited.
 */
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace ElizaStagingProof {
    public sealed class Job : IDisposable {
        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimits {
            public long ProcessTime, JobTime;
            public uint Flags;
            public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            public uint ActiveProcesses;
            public UIntPtr Affinity;
            public uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters {
            public ulong ReadOperations, WriteOperations, OtherOperations;
            public ulong ReadBytes, WriteBytes, OtherBytes;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimits {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref ExtendedLimits limits, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
        private IntPtr handle;

        public Job() {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(limits))) {
                int error = Marshal.GetLastWin32Error();
                Dispose();
                throw new Win32Exception(error);
            }
        }
        public void Assign(IntPtr process) {
            if (!AssignProcessToJobObject(handle, process)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        public void Dispose() {
            if (handle != IntPtr.Zero) {
                if (!CloseHandle(handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
                handle = IntPtr.Zero;
            }
        }
    }
}
