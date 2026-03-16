use std::collections::HashMap;

use chrono::{DateTime, Utc};

use crate::schedule::compute_next_run;
use crate::types::{JobDefinition, JobState, JobUpdate};

/// In-memory storage for cron job definitions.
///
/// Thread-safe usage requires external synchronisation (e.g. wrapping in
/// `tokio::sync::RwLock`).
pub struct CronStorage {
    jobs: HashMap<String, JobDefinition>,
}

impl CronStorage {
    /// Creates a new, empty storage instance.
    pub fn new() -> Self {
        Self {
            jobs: HashMap::new(),
        }
    }

    /// Returns the number of stored jobs.
    pub fn len(&self) -> usize {
        self.jobs.len()
    }

    /// Returns `true` if no jobs are stored.
    pub fn is_empty(&self) -> bool {
        self.jobs.is_empty()
    }

    /// Adds a job to storage.
    ///
    /// Returns an error if a job with the same ID already exists.
    pub fn add_job(&mut self, job: JobDefinition) -> Result<(), String> {
        if self.jobs.contains_key(&job.id) {
            return Err(format!("Job already exists: {}", job.id));
        }
        self.jobs.insert(job.id.clone(), job);
        Ok(())
    }

    /// Retrieves a reference to a job by its ID.
    pub fn get_job(&self, id: &str) -> Option<&JobDefinition> {
        self.jobs.get(id)
    }

    /// Retrieves a mutable reference to a job by its ID.
    pub fn get_job_mut(&mut self, id: &str) -> Option<&mut JobDefinition> {
        self.jobs.get_mut(id)
    }

    /// Updates a job in-place using the provided partial update.
    ///
    /// Returns an error if the job does not exist.
    pub fn update_job(&mut self, id: &str, updates: JobUpdate) -> Result<(), String> {
        let job = self
            .jobs
            .get_mut(id)
            .ok_or_else(|| format!("Job not found: {}", id))?;

        let now = Utc::now();

        if let Some(name) = updates.name {
            job.name = name;
        }
        if let Some(desc) = updates.description {
            job.description = desc;
        }
        if let Some(schedule) = updates.schedule {
            job.schedule = schedule;
            // Recompute next run when schedule changes
            job.next_run = compute_next_run(&job.schedule, now);
        }
        if let Some(payload) = updates.payload {
            job.payload = payload;
        }
        if let Some(state) = updates.state {
            job.state = state;
        }
        if let Some(max_runs) = updates.max_runs {
            job.max_runs = max_runs;
        }
        if let Some(room_id) = updates.room_id {
            job.room_id = room_id;
        }

        job.updated_at = now;
        Ok(())
    }

    /// Deletes a job by its ID. Returns `true` if the job existed.
    pub fn delete_job(&mut self, id: &str) -> Result<bool, String> {
        Ok(self.jobs.remove(id).is_some())
    }

    /// Lists all jobs, optionally filtered by state.
    pub fn list_jobs(&self, filter: Option<JobState>) -> Vec<&JobDefinition> {
        let mut result: Vec<&JobDefinition> = match filter {
            Some(ref state) => self.jobs.values().filter(|j| j.state == *state).collect(),
            None => self.jobs.values().collect(),
        };
        // Sort by next_run ascending; jobs without next_run go last
        result.sort_by(|a, b| {
            let a_next = a.next_run.unwrap_or(DateTime::<Utc>::MAX_UTC);
            let b_next = b.next_run.unwrap_or(DateTime::<Utc>::MAX_UTC);
            a_next.cmp(&b_next)
        });
        result
    }

    /// Returns all jobs whose `next_run` is at or before `now`.
    pub fn get_due_jobs(&self, now: DateTime<Utc>) -> Vec<&JobDefinition> {
        let mut due: Vec<&JobDefinition> = self
            .jobs
            .values()
            .filter(|j| {
                j.state == JobState::Active
                    && j.next_run.map(|nr| nr <= now).unwrap_or(false)
            })
            .collect();
        due.sort_by_key(|j| j.next_run);
        due
    }

    /// Finds a job by name (case-insensitive).
    pub fn find_by_name(&self, name: &str) -> Option<&JobDefinition> {
        let lower = name.to_lowercase();
        self.jobs
            .values()
            .find(|j| j.name.to_lowercase() == lower)
    }
}

impl Default for CronStorage {
    fn default() -> Self {
        Self::new()
    }
}
