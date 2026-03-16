use chrono::{Duration, Utc};
use elizaos_plugin_cron::{
    compute_next_run, format_schedule, parse_natural_language_schedule, parse_schedule,
    validate_cron_expression, CronConfig, CronService, CronStorage, JobDefinition, JobState,
    JobUpdate, PayloadType, ScheduleType,
};

// ===========================================================================
// Schedule Parsing Tests
// ===========================================================================

#[test]
fn test_validate_standard_cron_expressions() {
    assert!(validate_cron_expression("* * * * *"));
    assert!(validate_cron_expression("0 9 * * 1-5"));
    assert!(validate_cron_expression("*/5 * * * *"));
    assert!(validate_cron_expression("0 0 1 1 *"));
    assert!(validate_cron_expression("30 14 * * 0,6"));
}

#[test]
fn test_reject_invalid_cron_expressions() {
    assert!(!validate_cron_expression(""));
    assert!(!validate_cron_expression("not a cron"));
    assert!(!validate_cron_expression("60 * * * *")); // minute > 59
    assert!(!validate_cron_expression("* 25 * * *")); // hour > 23
    assert!(!validate_cron_expression("* * 32 * *")); // dom > 31
    assert!(!validate_cron_expression("* * * 13 *")); // month > 12
    assert!(!validate_cron_expression("* * * * 8")); // dow > 7
    assert!(!validate_cron_expression("* * * *")); // only 4 fields
}

#[test]
fn test_parse_schedule_iso_datetime() {
    let result = parse_schedule("2030-01-15T10:30:00Z");
    assert!(result.is_ok());
    match result.unwrap() {
        ScheduleType::At { at } => {
            assert_eq!(at.year(), 2030);
            assert_eq!(at.month(), 1);
        }
        _ => panic!("Expected At schedule"),
    }
}

#[test]
fn test_parse_schedule_duration() {
    let result = parse_schedule("30s");
    assert!(result.is_ok());
    match result.unwrap() {
        ScheduleType::Every { interval } => {
            assert_eq!(interval.num_seconds(), 30);
        }
        _ => panic!("Expected Every schedule"),
    }

    let result = parse_schedule("5m");
    assert!(result.is_ok());
    match result.unwrap() {
        ScheduleType::Every { interval } => {
            assert_eq!(interval.num_minutes(), 5);
        }
        _ => panic!("Expected Every schedule"),
    }
}

#[test]
fn test_parse_schedule_cron_expression() {
    let result = parse_schedule("0 9 * * 1-5");
    assert!(result.is_ok());
    match result.unwrap() {
        ScheduleType::Cron { expr } => {
            assert_eq!(expr, "0 9 * * 1-5");
        }
        _ => panic!("Expected Cron schedule"),
    }
}

#[test]
fn test_parse_schedule_rejects_garbage() {
    assert!(parse_schedule("").is_err());
    assert!(parse_schedule("not valid").is_err());
    assert!(parse_schedule("hello world").is_err());
}

#[test]
fn test_natural_language_every_n_units() {
    let s = parse_natural_language_schedule("every 5 minutes").unwrap();
    match s {
        ScheduleType::Every { interval } => assert_eq!(interval.num_minutes(), 5),
        _ => panic!("Expected Every"),
    }

    let s = parse_natural_language_schedule("every 2 hours").unwrap();
    match s {
        ScheduleType::Every { interval } => assert_eq!(interval.num_hours(), 2),
        _ => panic!("Expected Every"),
    }

    let s = parse_natural_language_schedule("every 30 seconds").unwrap();
    match s {
        ScheduleType::Every { interval } => assert_eq!(interval.num_seconds(), 30),
        _ => panic!("Expected Every"),
    }
}

#[test]
fn test_natural_language_daily_at() {
    let s = parse_natural_language_schedule("daily at 9am").unwrap();
    match s {
        ScheduleType::Cron { expr } => assert_eq!(expr, "0 9 * * *"),
        _ => panic!("Expected Cron"),
    }

    let s = parse_natural_language_schedule("daily at 14:30").unwrap();
    match s {
        ScheduleType::Cron { expr } => assert_eq!(expr, "30 14 * * *"),
        _ => panic!("Expected Cron"),
    }
}

#[test]
fn test_natural_language_keywords() {
    let s = parse_natural_language_schedule("hourly").unwrap();
    match s {
        ScheduleType::Cron { expr } => assert_eq!(expr, "0 * * * *"),
        _ => panic!("Expected Cron"),
    }

    let s = parse_natural_language_schedule("daily").unwrap();
    match s {
        ScheduleType::Cron { expr } => assert_eq!(expr, "0 0 * * *"),
        _ => panic!("Expected Cron"),
    }

    let s = parse_natural_language_schedule("weekly").unwrap();
    match s {
        ScheduleType::Cron { expr } => assert_eq!(expr, "0 0 * * 0"),
        _ => panic!("Expected Cron"),
    }
}

#[test]
fn test_natural_language_invalid() {
    assert!(parse_natural_language_schedule("").is_none());
    assert!(parse_natural_language_schedule("whenever you feel like it").is_none());
}

// ===========================================================================
// Next Run Computation Tests
// ===========================================================================

#[test]
fn test_compute_next_run_at_future() {
    let future = Utc::now() + Duration::try_hours(1).unwrap();
    let schedule = ScheduleType::At { at: future };
    let next = compute_next_run(&schedule, Utc::now());
    assert!(next.is_some());
    assert_eq!(next.unwrap(), future);
}

#[test]
fn test_compute_next_run_at_past() {
    let past = Utc::now() - Duration::try_hours(1).unwrap();
    let schedule = ScheduleType::At { at: past };
    let next = compute_next_run(&schedule, Utc::now());
    assert!(next.is_none());
}

#[test]
fn test_compute_next_run_every() {
    let schedule = ScheduleType::Every {
        interval: Duration::try_minutes(10).unwrap(),
    };
    let now = Utc::now();
    let next = compute_next_run(&schedule, now).unwrap();
    let diff = (next - now).num_minutes();
    assert_eq!(diff, 10);
}

#[test]
fn test_compute_next_run_cron() {
    let schedule = ScheduleType::Cron {
        expr: "* * * * *".to_string(), // every minute
    };
    let now = Utc::now();
    let next = compute_next_run(&schedule, now);
    assert!(next.is_some());
    let diff = (next.unwrap() - now).num_seconds();
    assert!(diff > 0 && diff <= 120); // within 2 minutes
}

// ===========================================================================
// Format Schedule Tests
// ===========================================================================

#[test]
fn test_format_every_durations() {
    assert_eq!(
        format_schedule(&ScheduleType::Every {
            interval: Duration::try_seconds(30).unwrap()
        }),
        "every 30 seconds"
    );
    assert_eq!(
        format_schedule(&ScheduleType::Every {
            interval: Duration::try_minutes(5).unwrap()
        }),
        "every 5 minutes"
    );
    assert_eq!(
        format_schedule(&ScheduleType::Every {
            interval: Duration::try_hours(1).unwrap()
        }),
        "every 1 hour"
    );
    assert_eq!(
        format_schedule(&ScheduleType::Every {
            interval: Duration::try_days(2).unwrap()
        }),
        "every 2 days"
    );
}

#[test]
fn test_format_cron() {
    assert_eq!(
        format_schedule(&ScheduleType::Cron {
            expr: "0 9 * * 1-5".to_string()
        }),
        "cron: 0 9 * * 1-5"
    );
}

// ===========================================================================
// Storage CRUD Tests
// ===========================================================================

fn make_job(name: &str, state: JobState) -> JobDefinition {
    let now = Utc::now();
    JobDefinition {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        description: None,
        schedule: ScheduleType::Every {
            interval: Duration::try_minutes(5).unwrap(),
        },
        payload: PayloadType::Prompt {
            text: "test".to_string(),
        },
        state,
        created_at: now,
        updated_at: now,
        last_run: None,
        next_run: Some(now + Duration::try_minutes(5).unwrap()),
        run_count: 0,
        max_runs: None,
        room_id: None,
    }
}

#[test]
fn test_storage_add_and_get() {
    let mut storage = CronStorage::new();
    let job = make_job("test-job", JobState::Active);
    let id = job.id.clone();

    storage.add_job(job).unwrap();
    assert_eq!(storage.len(), 1);

    let retrieved = storage.get_job(&id).unwrap();
    assert_eq!(retrieved.name, "test-job");
}

#[test]
fn test_storage_duplicate_id_rejected() {
    let mut storage = CronStorage::new();
    let job = make_job("job-1", JobState::Active);
    let id = job.id.clone();
    storage.add_job(job).unwrap();

    let dup = JobDefinition {
        id,
        name: "job-dup".to_string(),
        description: None,
        schedule: ScheduleType::Every {
            interval: Duration::try_minutes(1).unwrap(),
        },
        payload: PayloadType::Prompt {
            text: "dup".to_string(),
        },
        state: JobState::Active,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        last_run: None,
        next_run: None,
        run_count: 0,
        max_runs: None,
        room_id: None,
    };
    assert!(storage.add_job(dup).is_err());
}

#[test]
fn test_storage_update() {
    let mut storage = CronStorage::new();
    let job = make_job("original", JobState::Active);
    let id = job.id.clone();
    storage.add_job(job).unwrap();

    storage
        .update_job(
            &id,
            JobUpdate {
                name: Some("renamed".to_string()),
                state: Some(JobState::Paused),
                ..Default::default()
            },
        )
        .unwrap();

    let updated = storage.get_job(&id).unwrap();
    assert_eq!(updated.name, "renamed");
    assert_eq!(updated.state, JobState::Paused);
}

#[test]
fn test_storage_update_nonexistent() {
    let mut storage = CronStorage::new();
    let result = storage.update_job(
        "nope",
        JobUpdate {
            name: Some("x".to_string()),
            ..Default::default()
        },
    );
    assert!(result.is_err());
}

#[test]
fn test_storage_delete() {
    let mut storage = CronStorage::new();
    let job = make_job("deletable", JobState::Active);
    let id = job.id.clone();
    storage.add_job(job).unwrap();

    assert!(storage.delete_job(&id).unwrap());
    assert_eq!(storage.len(), 0);
    assert!(storage.get_job(&id).is_none());
}

#[test]
fn test_storage_delete_nonexistent() {
    let mut storage = CronStorage::new();
    assert!(!storage.delete_job("nope").unwrap());
}

#[test]
fn test_storage_list_all() {
    let mut storage = CronStorage::new();
    storage.add_job(make_job("a", JobState::Active)).unwrap();
    storage.add_job(make_job("b", JobState::Paused)).unwrap();
    storage.add_job(make_job("c", JobState::Active)).unwrap();

    let all = storage.list_jobs(None);
    assert_eq!(all.len(), 3);
}

#[test]
fn test_storage_list_filtered() {
    let mut storage = CronStorage::new();
    storage.add_job(make_job("a", JobState::Active)).unwrap();
    storage.add_job(make_job("b", JobState::Paused)).unwrap();
    storage.add_job(make_job("c", JobState::Active)).unwrap();

    let active = storage.list_jobs(Some(JobState::Active));
    assert_eq!(active.len(), 2);

    let paused = storage.list_jobs(Some(JobState::Paused));
    assert_eq!(paused.len(), 1);

    let completed = storage.list_jobs(Some(JobState::Completed));
    assert_eq!(completed.len(), 0);
}

#[test]
fn test_storage_get_due_jobs() {
    let mut storage = CronStorage::new();
    let now = Utc::now();

    let mut due_job = make_job("due", JobState::Active);
    due_job.next_run = Some(now - Duration::try_minutes(1).unwrap());
    storage.add_job(due_job).unwrap();

    let mut future_job = make_job("future", JobState::Active);
    future_job.next_run = Some(now + Duration::try_hours(1).unwrap());
    storage.add_job(future_job).unwrap();

    let mut paused_due = make_job("paused-due", JobState::Paused);
    paused_due.next_run = Some(now - Duration::try_minutes(1).unwrap());
    storage.add_job(paused_due).unwrap();

    let due = storage.get_due_jobs(now);
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].name, "due");
}

#[test]
fn test_storage_find_by_name() {
    let mut storage = CronStorage::new();
    storage.add_job(make_job("Daily Check", JobState::Active)).unwrap();
    storage.add_job(make_job("hourly sync", JobState::Active)).unwrap();

    assert!(storage.find_by_name("daily check").is_some());
    assert!(storage.find_by_name("DAILY CHECK").is_some());
    assert!(storage.find_by_name("nonexistent").is_none());
}

// ===========================================================================
// Service Integration Tests
// ===========================================================================

#[test]
fn test_service_create_list_update_delete_lifecycle() {
    let mut svc = CronService::with_defaults();

    // Create
    let job = svc
        .create_job(
            "lifecycle-test".to_string(),
            Some("A test job".to_string()),
            ScheduleType::Every {
                interval: Duration::try_minutes(10).unwrap(),
            },
            PayloadType::Prompt {
                text: "Do something".to_string(),
            },
            None,
            None,
        )
        .unwrap();

    assert_eq!(job.name, "lifecycle-test");
    assert_eq!(job.state, JobState::Active);
    assert!(job.next_run.is_some());

    let id = job.id.clone();

    // List
    let jobs = svc.list_jobs(None);
    assert_eq!(jobs.len(), 1);

    // Update
    let updated = svc
        .update_job(
            &id,
            JobUpdate {
                name: Some("renamed-test".to_string()),
                state: Some(JobState::Paused),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(updated.name, "renamed-test");
    assert_eq!(updated.state, JobState::Paused);

    // Delete
    assert!(svc.delete_job(&id).unwrap());
    assert_eq!(svc.list_jobs(None).len(), 0);
}

#[test]
fn test_service_max_jobs_limit() {
    let config = CronConfig {
        enabled: true,
        max_jobs: 2,
        default_timeout_ms: 30_000,
    };
    let mut svc = CronService::new(config);

    svc.create_job(
        "job-1".to_string(),
        None,
        ScheduleType::Every {
            interval: Duration::try_minutes(1).unwrap(),
        },
        PayloadType::Prompt {
            text: "a".to_string(),
        },
        None,
        None,
    )
    .unwrap();

    svc.create_job(
        "job-2".to_string(),
        None,
        ScheduleType::Every {
            interval: Duration::try_minutes(1).unwrap(),
        },
        PayloadType::Prompt {
            text: "b".to_string(),
        },
        None,
        None,
    )
    .unwrap();

    let result = svc.create_job(
        "job-3".to_string(),
        None,
        ScheduleType::Every {
            interval: Duration::try_minutes(1).unwrap(),
        },
        PayloadType::Prompt {
            text: "c".to_string(),
        },
        None,
        None,
    );
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("Maximum job limit"));
}

#[test]
fn test_service_disabled() {
    let config = CronConfig {
        enabled: false,
        max_jobs: 100,
        default_timeout_ms: 30_000,
    };
    let mut svc = CronService::new(config);

    let result = svc.create_job(
        "test".to_string(),
        None,
        ScheduleType::Every {
            interval: Duration::try_minutes(1).unwrap(),
        },
        PayloadType::Prompt {
            text: "x".to_string(),
        },
        None,
        None,
    );
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("disabled"));
}

#[test]
fn test_service_run_job() {
    let mut svc = CronService::with_defaults();

    let job = svc
        .create_job(
            "runner".to_string(),
            None,
            ScheduleType::Every {
                interval: Duration::try_minutes(5).unwrap(),
            },
            PayloadType::Prompt {
                text: "run me".to_string(),
            },
            None,
            None,
        )
        .unwrap();

    let ran = svc.run_job(&job.id).unwrap();
    assert_eq!(ran.run_count, 1);
    assert!(ran.last_run.is_some());
    assert_eq!(ran.state, JobState::Active);
}

#[test]
fn test_service_run_job_with_max_runs() {
    let mut svc = CronService::with_defaults();

    let job = svc
        .create_job(
            "limited".to_string(),
            None,
            ScheduleType::Every {
                interval: Duration::try_minutes(1).unwrap(),
            },
            PayloadType::Prompt {
                text: "x".to_string(),
            },
            Some(2),
            None,
        )
        .unwrap();

    svc.run_job(&job.id).unwrap();
    let finished = svc.run_job(&job.id).unwrap();
    assert_eq!(finished.run_count, 2);
    assert_eq!(finished.state, JobState::Completed);
}

#[test]
fn test_service_run_at_schedule_completes() {
    let mut svc = CronService::with_defaults();

    let future = Utc::now() + Duration::try_hours(1).unwrap();
    let job = svc
        .create_job(
            "one-shot".to_string(),
            None,
            ScheduleType::At { at: future },
            PayloadType::Prompt {
                text: "once".to_string(),
            },
            None,
            None,
        )
        .unwrap();

    let ran = svc.run_job(&job.id).unwrap();
    assert_eq!(ran.state, JobState::Completed);
    assert!(ran.next_run.is_none());
}

#[test]
fn test_service_invalid_cron_expression() {
    let mut svc = CronService::with_defaults();

    let result = svc.create_job(
        "bad-cron".to_string(),
        None,
        ScheduleType::Cron {
            expr: "not valid".to_string(),
        },
        PayloadType::Prompt {
            text: "x".to_string(),
        },
        None,
        None,
    );
    assert!(result.is_err());
}

#[test]
fn test_service_invalid_interval() {
    let mut svc = CronService::with_defaults();

    let result = svc.create_job(
        "bad-interval".to_string(),
        None,
        ScheduleType::Every {
            interval: Duration::try_milliseconds(0).unwrap(),
        },
        PayloadType::Prompt {
            text: "x".to_string(),
        },
        None,
        None,
    );
    assert!(result.is_err());
}

#[test]
fn test_service_find_by_name() {
    let mut svc = CronService::with_defaults();

    svc.create_job(
        "My Job".to_string(),
        None,
        ScheduleType::Every {
            interval: Duration::try_minutes(1).unwrap(),
        },
        PayloadType::Prompt {
            text: "x".to_string(),
        },
        None,
        None,
    )
    .unwrap();

    assert!(svc.find_job_by_name("my job").is_some());
    assert!(svc.find_job_by_name("MY JOB").is_some());
    assert!(svc.find_job_by_name("nonexistent").is_none());
}

#[test]
fn test_service_action_payload() {
    let mut svc = CronService::with_defaults();

    let job = svc
        .create_job(
            "action-job".to_string(),
            None,
            ScheduleType::Every {
                interval: Duration::try_hours(1).unwrap(),
            },
            PayloadType::Action {
                name: "SEND_EMAIL".to_string(),
                params: Some(
                    [("to".to_string(), serde_json::json!("user@example.com"))]
                        .into_iter()
                        .collect(),
                ),
            },
            None,
            None,
        )
        .unwrap();

    match &job.payload {
        PayloadType::Action { name, params } => {
            assert_eq!(name, "SEND_EMAIL");
            assert!(params.is_some());
        }
        _ => panic!("Expected Action payload"),
    }
}

#[test]
fn test_service_event_payload() {
    let mut svc = CronService::with_defaults();

    let job = svc
        .create_job(
            "event-job".to_string(),
            None,
            ScheduleType::Cron {
                expr: "0 0 * * *".to_string(),
            },
            PayloadType::Event {
                name: "daily_reset".to_string(),
                data: None,
            },
            None,
            None,
        )
        .unwrap();

    match &job.payload {
        PayloadType::Event { name, data } => {
            assert_eq!(name, "daily_reset");
            assert!(data.is_none());
        }
        _ => panic!("Expected Event payload"),
    }
}

// ===========================================================================
// Cron Field Edge Cases
// ===========================================================================

#[test]
fn test_cron_step_values() {
    assert!(validate_cron_expression("*/15 * * * *"));
    assert!(validate_cron_expression("0 */2 * * *"));
    assert!(validate_cron_expression("0 0 */3 * *"));
}

#[test]
fn test_cron_list_values() {
    assert!(validate_cron_expression("0 9,12,15 * * *"));
    assert!(validate_cron_expression("0 0 1,15 * *"));
}

#[test]
fn test_cron_range_values() {
    assert!(validate_cron_expression("0 9-17 * * 1-5"));
    assert!(validate_cron_expression("0-30 * * * *"));
}

#[test]
fn test_compute_next_cron_every_minute() {
    let schedule = ScheduleType::Cron {
        expr: "* * * * *".to_string(),
    };
    let now = Utc::now();
    let next = compute_next_run(&schedule, now).unwrap();
    // Must be within 2 minutes
    assert!((next - now).num_seconds() <= 120);
    assert!(next > now);
}

use chrono::Datelike;

#[test]
fn test_compute_next_cron_specific_hour() {
    let schedule = ScheduleType::Cron {
        expr: "0 9 * * *".to_string(), // daily at 09:00
    };
    let now = Utc::now();
    let next = compute_next_run(&schedule, now).unwrap();
    assert_eq!(next.hour(), 9);
    assert_eq!(next.minute(), 0);
}

use chrono::Timelike;
