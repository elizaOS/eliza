use elizaos::settings::get_salt;

fn with_env_lock<T>(f: impl FnOnce() -> T) -> T {
    static ENV_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    let lock = ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
    // We deliberately recover from poisoning because some tests intentionally
    // trigger panics; we prevent poisoning via `catch_unwind` below, but this
    // keeps the helper robust under parallel execution.
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f()
}

#[test]
fn get_salt_panics_in_production_when_default() {
    with_env_lock(|| {
        std::env::set_var("NODE_ENV", "production");
        std::env::remove_var("SECRET_SALT");
        std::env::remove_var("ELIZA_ALLOW_DEFAULT_SECRET_SALT");

        // Catch the panic while holding the env lock to avoid poisoning and to
        // prevent other tests from racing env access.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(get_salt));
        assert!(
            result.is_err(),
            "expected get_salt() to panic in production"
        );
    })
}

#[test]
fn get_salt_allows_override_in_production() {
    with_env_lock(|| {
        std::env::set_var("NODE_ENV", "production");
        std::env::remove_var("SECRET_SALT");
        std::env::set_var("ELIZA_ALLOW_DEFAULT_SECRET_SALT", "true");
        let salt = get_salt();
        assert_eq!(salt, "secretsalt");
    })
}
