use chrono::Utc;

/// Returns the current unix timestamp in milliseconds.
pub fn timestamp_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Returns the floor of the timestamp to the given window size in milliseconds.
pub fn window_start_ms(ts_ms: i64, window_ms: i64) -> i64 {
    if window_ms <= 0 {
        return ts_ms;
    }
    (ts_ms / window_ms) * window_ms
}
