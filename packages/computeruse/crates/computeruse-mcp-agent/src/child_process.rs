//! Child Process Registry with Job Object Support (Windows-only)
//!
//! On Windows, this module uses Job Objects with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
//! to ensure all child processes are automatically terminated when parent exits.

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};
use tracing::{debug, info, warn};

#[derive(Debug, Clone)]
pub struct ChildProcessInfo {
    pub pid: u32,
    pub execution_id: Option<String>,
    pub started_at: std::time::Instant,
}

static CHILD_PROCESSES: OnceLock<RwLock<HashMap<u32, ChildProcessInfo>>> = OnceLock::new();

fn get_registry() -> &'static RwLock<HashMap<u32, ChildProcessInfo>> {
    CHILD_PROCESSES.get_or_init(|| RwLock::new(HashMap::new()))
}

#[cfg(target_os = "windows")]
mod job_object {
    use std::sync::OnceLock;
    use tracing::{debug, error, info, warn};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_ALL_ACCESS};

    static JOB_OBJECT: OnceLock<JobObjectHandle> = OnceLock::new();
    struct JobObjectHandle(HANDLE);
    unsafe impl Send for JobObjectHandle {}
    unsafe impl Sync for JobObjectHandle {}

    impl Drop for JobObjectHandle {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    pub fn init() -> bool {
        JOB_OBJECT
            .get_or_init(|| match create_job_object() {
                Some(h) => {
                    info!("Job object created - child processes will be auto-terminated on exit");
                    JobObjectHandle(h)
                }
                None => {
                    warn!("Failed to create job object - falling back to registry-based cleanup");
                    JobObjectHandle(HANDLE::default())
                }
            })
            .0
            != HANDLE::default()
    }

    fn create_job_object() -> Option<HANDLE> {
        unsafe {
            let job = match CreateJobObjectW(None, None) {
                Ok(h) => h,
                Err(e) => {
                    error!("CreateJobObjectW failed: {:?}", e);
                    return None;
                }
            };
            if job.is_invalid() {
                error!("CreateJobObjectW returned invalid handle");
                return None;
            }
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Err(e) = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) {
                error!("SetInformationJobObject failed: {:?}", e);
                let _ = CloseHandle(job);
                return None;
            }
            debug!("Job object configured with KILL_ON_JOB_CLOSE");
            Some(job)
        }
    }

    pub fn assign_process(pid: u32) -> bool {
        let job_handle = match JOB_OBJECT.get() {
            Some(h) if h.0 != HANDLE::default() => h.0,
            _ => {
                debug!(
                    "Job object not initialized, skipping assignment for PID {}",
                    pid
                );
                return false;
            }
        };
        unsafe {
            let ph = match OpenProcess(PROCESS_ALL_ACCESS, false, pid) {
                Ok(h) => h,
                Err(e) => {
                    warn!("Failed to open process {} for job assignment: {:?}", pid, e);
                    return false;
                }
            };
            if ph.is_invalid() {
                warn!("OpenProcess returned invalid handle for PID {}", pid);
                return false;
            }
            let result = AssignProcessToJobObject(job_handle, ph);
            let _ = CloseHandle(ph);
            match result {
                Ok(_) => {
                    debug!("Assigned PID {} to job object", pid);
                    true
                }
                Err(e) => {
                    warn!("Failed to assign PID {} to job object: {:?}", pid, e);
                    false
                }
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod job_object {
    pub fn init() -> bool {
        true
    }
    pub fn assign_process(_pid: u32) -> bool {
        true
    }
}

pub fn init_job_object() -> bool {
    job_object::init()
}

pub fn register(pid: u32, execution_id: Option<String>) {
    let assigned = job_object::assign_process(pid);
    if assigned {
        debug!("PID {} assigned to job object for automatic cleanup", pid);
    }
    let info = ChildProcessInfo {
        pid,
        execution_id: execution_id.clone(),
        started_at: std::time::Instant::now(),
    };
    if let Ok(mut registry) = get_registry().write() {
        debug!(
            "Registering child process PID {} (execution_id: {:?}, job_assigned: {})",
            pid, execution_id, assigned
        );
        registry.insert(pid, info);
    }
}

pub fn unregister(pid: u32) {
    if let Ok(mut registry) = get_registry().write() {
        if registry.remove(&pid).is_some() {
            debug!("Unregistered child process PID {}", pid);
        }
    }
}

/// Kill all child processes matching an execution_id (used by stop_execution)
pub fn kill_by_execution_id(execution_id: &str) -> usize {
    info!(
        "[STOP-DEBUG] kill_by_execution_id called for: {}",
        execution_id
    );
    let pids_to_kill: Vec<ChildProcessInfo> = match get_registry().write() {
        Ok(mut registry) => {
            let matching: Vec<u32> = registry
                .iter()
                .filter(|(_, info)| info.execution_id.as_deref() == Some(execution_id))
                .map(|(pid, _)| *pid)
                .collect();
            matching
                .iter()
                .filter_map(|pid| registry.remove(pid))
                .collect()
        }
        Err(e) => {
            warn!("Failed to acquire child process registry lock: {}", e);
            return 0;
        }
    };
    let count = pids_to_kill.len();
    if count == 0 {
        debug!(
            "[STOP-DEBUG] No child processes found for execution_id: {}",
            execution_id
        );
        return 0;
    }
    info!(
        "[STOP-DEBUG] Killing {} child process(es) for execution_id: {}",
        count, execution_id
    );
    for info in pids_to_kill {
        kill_process(info.pid, info.execution_id.as_deref());
    }
    count
}

pub fn active_count() -> usize {
    get_registry().read().map(|r| r.len()).unwrap_or(0)
}

pub fn kill_all() {
    let pids_to_kill: Vec<ChildProcessInfo> = match get_registry().write() {
        Ok(mut r) => r.drain().map(|(_, i)| i).collect(),
        Err(e) => {
            warn!("Failed to acquire child process registry lock: {}", e);
            return;
        }
    };
    if pids_to_kill.is_empty() {
        debug!("No child processes to clean up");
        return;
    }
    info!(
        "Cleaning up {} child process(es) on shutdown",
        pids_to_kill.len()
    );
    for info in pids_to_kill {
        kill_process(info.pid, info.execution_id.as_deref());
    }
}

#[cfg(target_os = "windows")]
fn kill_process(pid: u32, execution_id: Option<&str>) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        match OpenProcess(PROCESS_TERMINATE, false, pid) {
            Ok(handle) => {
                if !handle.is_invalid() {
                    match TerminateProcess(handle, 1) {
                        Ok(_) => {
                            info!(
                                "Terminated child process PID {} (execution_id: {:?})",
                                pid, execution_id
                            );
                        }
                        Err(e) => {
                            warn!("Failed to terminate process PID {}: {:?}", pid, e);
                        }
                    }
                    let _ = CloseHandle(handle);
                }
            }
            Err(e) => {
                debug!(
                    "Could not open process PID {} for termination: {:?}",
                    pid, e
                );
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn kill_process(_pid: u32, _execution_id: Option<&str>) {}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_register_unregister() {
        if let Ok(mut registry) = get_registry().write() {
            registry.clear();
        }
        register(12345, Some("test-exec-1".to_string()));
        assert_eq!(active_count(), 1);
        register(12346, None);
        assert_eq!(active_count(), 2);
        unregister(12345);
        assert_eq!(active_count(), 1);
        unregister(12346);
        assert_eq!(active_count(), 0);
    }
    #[test]
    fn test_unregister_nonexistent() {
        unregister(99999);
    }
    #[test]
    fn test_kill_all_empty() {
        if let Ok(mut registry) = get_registry().write() {
            registry.clear();
        }
        kill_all();
        assert_eq!(active_count(), 0);
    }
    #[test]
    fn test_init_job_object() {
        let result = init_job_object();
        #[cfg(not(target_os = "windows"))]
        assert!(result);
    }
}
