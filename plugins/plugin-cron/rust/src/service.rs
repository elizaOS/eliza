use chrono::Utc;
use tracing::info;
use uuid::Uuid;

use crate::schedule::{compute_next_run, format_schedule, validate_cron_expression};
use crate::storage::CronStorage;
use crate::types::{
    CronConfig, JobDefinition, JobState, JobUpdate, PayloadType, ScheduleType,
};

/// High-level cron service handling CRUD, scheduling, and execution coordination.
pub struct CronService {
    config: CronConfig,
    storage: CronStorage,
}

impl CronService {
    /// Creates a new `CronService` with the given configuration.
    pub fn new(config: CronConfig) -> Self {
        info!("CronService initialised (max_jobs={})", config.max_jobs);
        Self {
            config,
            storage: CronStorage::new(),
        }
    }

    /// Creates a service with default configuration.
    pub fn with_defaults() -> Self {
        Self::new(CronConfig::default())
    }

    /// Returns a reference to the configuration.
    pub fn config(&self) -> &CronConfig {
        &self.config
    }

    /// Returns the number of jobs currently stored.
    pub fn job_count(&self) -> usize {
        self.storage.len()
    }

    // -----------------------------------------------------------------------
    // CRUD
    // -----------------------------------------------------------------------

    /// Creates a new cron job.
    ///
    /// Validates the schedule, enforces the max-jobs limit, computes the first
    /// `next_run`, and stores the job.
    pub fn create_job(
        &mut self,
        name: String,
        description: Option<String>,
        schedule: ScheduleType,
        payload: PayloadType,
        max_runs: Option<u64>,
        room_id: Option<String>,
    ) -> Result<JobDefinition, String> {
        if !self.config.enabled {
            return Err("Cron service is disabled".to_string());
        }

        // Validate schedule
        self.validate_schedule(&schedule)?;

        // Check capacity
        if self.storage.len() >= self.config.max_jobs {
            return Err(format!(
                "Maximum job limit reached ({}). Delete some jobs first.",
                self.config.max_jobs
            ));
        }

        let now = Utc::now();
        let next_run = compute_next_run(&schedule, now);

        let job = JobDefinition {
            id: Uuid::new_v4().to_string(),
            name,
            description,
            schedule,
            payload,
            state: JobState::Active,
            created_at: now,
            updated_at: now,
            last_run: None,
            next_run,
            run_count: 0,
            max_runs,
            room_id,
        };

        self.storage.add_job(job.clone())?;

        info!(
            "Created job \"{}\" ({}) - {}",
            job.name,
            job.id,
            format_schedule(&job.schedule)
        );

        Ok(job)
    }

    /// Updates an existing job.
    pub fn update_job(&mut self, id: &str, updates: JobUpdate) -> Result<JobDefinition, String> {
        if !self.config.enabled {
            return Err("Cron service is disabled".to_string());
        }

        // Validate new schedule if provided
        if let Some(ref schedule) = updates.schedule {
            self.validate_schedule(schedule)?;
        }

        self.storage.update_job(id, updates)?;

        let job = self
            .storage
            .get_job(id)
            .ok_or_else(|| format!("Job not found after update: {}", id))?
            .clone();

        info!("Updated job \"{}\" ({})", job.name, job.id);
        Ok(job)
    }

    /// Deletes a job by ID.
    pub fn delete_job(&mut self, id: &str) -> Result<bool, String> {
        let name = self.storage.get_job(id).map(|j| j.name.clone());
        let deleted = self.storage.delete_job(id)?;
        if deleted {
            if let Some(name) = name {
                info!("Deleted job \"{}\" ({})", name, id);
            }
        }
        Ok(deleted)
    }

    /// Gets a job by ID.
    pub fn get_job(&self, id: &str) -> Option<&JobDefinition> {
        self.storage.get_job(id)
    }

    /// Lists all jobs, optionally filtered by state.
    pub fn list_jobs(&self, filter: Option<JobState>) -> Vec<&JobDefinition> {
        self.storage.list_jobs(filter)
    }

    /// Finds a job by name (case-insensitive).
    pub fn find_job_by_name(&self, name: &str) -> Option<&JobDefinition> {
        self.storage.find_by_name(name)
    }

    // -----------------------------------------------------------------------
    // Execution
    // -----------------------------------------------------------------------

    /// Simulates running a job: updates run count, last_run, and next_run.
    ///
    /// In a real runtime this would dispatch to the agent. Here we handle
    /// the state-management portion so tests and callers see correct transitions.
    pub fn run_job(&mut self, id: &str) -> Result<JobDefinition, String> {
        if !self.config.enabled {
            return Err("Cron service is disabled".to_string());
        }

        let job = self
            .storage
            .get_job(id)
            .ok_or_else(|| format!("Job not found: {}", id))?
            .clone();

        let now = Utc::now();
        let next = compute_next_run(&job.schedule, now);

        let new_run_count = job.run_count + 1;
        let new_state = if let Some(max) = job.max_runs {
            if new_run_count >= max {
                JobState::Completed
            } else {
                job.state.clone()
            }
        } else {
            job.state.clone()
        };

        // For one-shot At schedules, mark completed after run
        let new_state = match &job.schedule {
            ScheduleType::At { .. } => JobState::Completed,
            _ => new_state,
        };

        self.storage.update_job(
            id,
            JobUpdate {
                state: Some(new_state),
                ..Default::default()
            },
        )?;

        // Manually set runtime fields
        let job_mut = self
            .storage
            .get_job_mut(id)
            .ok_or("Job disappeared")?;

        job_mut.last_run = Some(now);
        job_mut.run_count = new_run_count;
        job_mut.next_run = if job_mut.state == JobState::Completed {
            None
        } else {
            next
        };
        job_mut.updated_at = now;

        let result = job_mut.clone();
        info!(
            "Ran job \"{}\" ({}) - run #{}, state={:?}",
            result.name, result.id, result.run_count, result.state
        );
        Ok(result)
    }

    /// Returns all jobs that are due for execution at `now`.
    pub fn get_due_jobs(&self) -> Vec<&JobDefinition> {
        self.storage.get_due_jobs(Utc::now())
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn validate_schedule(&self, schedule: &ScheduleType) -> Result<(), String> {
        match schedule {
            ScheduleType::At { at } => {
                if *at <= Utc::now() {
                    // We allow past timestamps for testing but log a warning
                    tracing::warn!("Schedule 'at' time is in the past: {}", at);
                }
                Ok(())
            }
            ScheduleType::Every { interval } => {
                if interval.num_milliseconds() <= 0 {
                    Err("Interval must be positive".to_string())
                } else {
                    Ok(())
                }
            }
            ScheduleType::Cron { expr } => {
                if validate_cron_expression(expr) {
                    Ok(())
                } else {
                    Err(format!("Invalid cron expression: {}", expr))
                }
            }
        }
    }
}
