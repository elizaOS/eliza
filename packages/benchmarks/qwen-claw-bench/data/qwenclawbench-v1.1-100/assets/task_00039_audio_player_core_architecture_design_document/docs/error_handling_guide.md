# Error Handling Patterns in Rust

A practical guide to error handling in Rust applications, covering common
patterns, crate choices, and best practices.

## Table of Contents

1. [The Error Landscape](#the-error-landscape)
2. [thiserror vs anyhow](#thiserror-vs-anyhow)
3. [Custom Error Enums](#custom-error-enums)
4. [The ? Operator](#the--operator)
5. [Adding Context](#adding-context)
6. [Logging Errors](#logging-errors)
7. [Error Recovery Strategies](#error-recovery-strategies)

---

## The Error Landscape

Rust's error handling is built on two core types:

- `Result<T, E>` — for recoverable errors
- `panic!` — for unrecoverable errors (bugs)

The golden rule: **use `Result` for expected failures, `panic!` for programming
errors.**

## thiserror vs anyhow

### thiserror

`thiserror` is a derive macro for creating custom error types. Use it in
**libraries** where callers need to match on specific error variants.

```rust
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ServerError {
    #[error("connection refused: {addr}")]
    ConnectionRefused { addr: String },

    #[error("request timeout after {duration_ms}ms")]
    Timeout { duration_ms: u64 },

    #[error("invalid header: {0}")]
    InvalidHeader(String),

    #[error("database error")]
    Database(#[from] sqlx::Error),

    #[error("serialization failed")]
    Serialization(#[from] serde_json::Error),
}
```

### anyhow

`anyhow` provides a catch-all `anyhow::Error` type. Use it in **applications**
where you just need to propagate errors up to the user.

```rust
use anyhow::{Context, Result};

async fn fetch_user(id: u64) -> Result<User> {
    let response = client
        .get(&format!("https://api.example.com/users/{}", id))
        .send()
        .await
        .context("failed to send HTTP request")?;

    let user: User = response
        .json()
        .await
        .context("failed to parse user JSON")?;

    Ok(user)
}
```

### When to Use Which

| Scenario | Crate |
|----------|-------|
| Library crate | `thiserror` |
| Application binary | `anyhow` |
| Internal module errors | `thiserror` |
| CLI tool | `anyhow` |
| Public API | `thiserror` |

## Custom Error Enums

A well-designed error enum should:

1. Cover all failure modes
2. Carry enough context for debugging
3. Implement `std::fmt::Display` meaningfully
4. Implement `std::error::Error`

### Example: Web Server Error Hierarchy

```rust
#[derive(Error, Debug)]
pub enum AppError {
    #[error("HTTP error: {0}")]
    Http(#[from] HttpError),

    #[error("database error: {0}")]
    Db(#[from] DbError),

    #[error("authentication failed: {reason}")]
    Auth { reason: String },
}

#[derive(Error, Debug)]
pub enum HttpError {
    #[error("connection to {host}:{port} refused")]
    ConnectionRefused { host: String, port: u16 },

    #[error("request timed out after {0}ms")]
    Timeout(u64),

    #[error("received status {status}: {body}")]
    BadStatus { status: u16, body: String },
}

#[derive(Error, Debug)]
pub enum DbError {
    #[error("connection pool exhausted")]
    PoolExhausted,

    #[error("query failed: {query}")]
    QueryFailed { query: String, source: sqlx::Error },

    #[error("migration error: {0}")]
    Migration(String),
}
```

## The ? Operator

The `?` operator is syntactic sugar for early return on error:

```rust
// These are equivalent:
fn read_config() -> Result<Config, io::Error> {
    let contents = fs::read_to_string("config.toml")?;
    let config: Config = toml::from_str(&contents)?;
    Ok(config)
}

// Desugared:
fn read_config() -> Result<Config, io::Error> {
    let contents = match fs::read_to_string("config.toml") {
        Ok(c) => c,
        Err(e) => return Err(e.into()),
    };
    let config = match toml::from_str(&contents) {
        Ok(c) => c,
        Err(e) => return Err(e.into()),
    };
    Ok(config)
}
```

### Chaining with ?

```rust
async fn handle_request(req: Request) -> Result<Response> {
    let body = req.body_string().await?;
    let payload: CreateUser = serde_json::from_str(&body)?;
    let user = db.create_user(payload).await?;
    let response = serde_json::to_string(&user)?;
    Ok(Response::ok(response))
}
```

## Adding Context

Raw errors often lack context about *what* was being done when the error
occurred. Use `.context()` from `anyhow` or build context into your error
variants:

```rust
use anyhow::Context;

async fn start_server(config: &ServerConfig) -> Result<()> {
    let listener = TcpListener::bind(&config.addr)
        .await
        .with_context(|| format!("failed to bind to {}", config.addr))?;

    let db_pool = PgPool::connect(&config.database_url)
        .await
        .context("failed to connect to database")?;

    let tls_config = load_tls_config(&config.cert_path, &config.key_path)
        .context("failed to load TLS certificates")?;

    run_server(listener, db_pool, tls_config).await
}
```

### Context in Custom Errors

```rust
#[derive(Error, Debug)]
pub enum ConfigError {
    #[error("failed to read config file at {path}")]
    ReadFailed {
        path: PathBuf,
        #[source]
        source: io::Error,
    },

    #[error("failed to parse config file at {path}")]
    ParseFailed {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
}
```

## Logging Errors

Use the `tracing` crate for structured error logging:

```rust
use tracing::{error, warn, info, instrument};

#[instrument(skip(db_pool))]
async fn handle_login(
    db_pool: &PgPool,
    username: &str,
    password: &str,
) -> Result<AuthToken, AppError> {
    let user = match db_pool.find_user(username).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            warn!(username, "login attempt for non-existent user");
            return Err(AppError::Auth {
                reason: "user not found".into(),
            });
        }
        Err(e) => {
            error!(username, error = %e, "database error during login");
            return Err(e.into());
        }
    };

    if !verify_password(password, &user.password_hash) {
        warn!(username, "failed login attempt - wrong password");
        return Err(AppError::Auth {
            reason: "invalid password".into(),
        });
    }

    info!(username, user_id = %user.id, "successful login");
    Ok(generate_token(&user))
}
```

### Error Logging Best Practices

1. **Log at the boundary** — log errors where they are handled, not where they
   are created
2. **Use structured fields** — `error!(user_id = %id, error = %e, "failed")`
   is better than `error!("failed for user {} with error {}", id, e)`
3. **Include the error chain** — use `{:?}` for the full chain, `{}` for just
   the top-level message
4. **Don't log and return** — either handle the error (log it) or propagate it,
   not both (unless you're adding context)

## Error Recovery Strategies

### Retry with Backoff

```rust
use tokio::time::{sleep, Duration};

async fn fetch_with_retry(url: &str, max_retries: u32) -> Result<Response> {
    let mut attempt = 0;
    loop {
        match client.get(url).send().await {
            Ok(resp) if resp.status().is_success() => return Ok(resp),
            Ok(resp) => {
                warn!(status = %resp.status(), attempt, "request failed");
            }
            Err(e) if attempt < max_retries => {
                let delay = Duration::from_millis(100 * 2u64.pow(attempt));
                warn!(error = %e, attempt, ?delay, "retrying after error");
                sleep(delay).await;
            }
            Err(e) => return Err(e.into()),
        }
        attempt += 1;
        if attempt > max_retries {
            anyhow::bail!("max retries ({}) exceeded for {}", max_retries, url);
        }
    }
}
```

### Fallback Values

```rust
fn get_config_value(key: &str) -> String {
    match config_store.get(key) {
        Ok(Some(value)) => value,
        Ok(None) => {
            warn!(key, "config key not found, using default");
            get_default(key)
        }
        Err(e) => {
            error!(key, error = %e, "config store error, using default");
            get_default(key)
        }
    }
}
```

### Circuit Breaker

```rust
struct CircuitBreaker {
    failure_count: AtomicU32,
    threshold: u32,
    reset_after: Duration,
    last_failure: Mutex<Option<Instant>>,
}

impl CircuitBreaker {
    fn is_open(&self) -> bool {
        if self.failure_count.load(Ordering::Relaxed) >= self.threshold {
            if let Some(last) = *self.last_failure.lock() {
                return last.elapsed() < self.reset_after;
            }
        }
        false
    }
}
```

---

*This guide covers general Rust error handling patterns. For project-specific
error types and handling strategies, consult the relevant module documentation.*
