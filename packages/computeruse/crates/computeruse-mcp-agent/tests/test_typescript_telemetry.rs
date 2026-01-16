//! Tests for TypeScript workflow telemetry integration
//!
//! This test verifies that TypeScript workflows properly propagate
//! execution_id and trace_id through tracing spans, enabling log
//! correlation in ClickHouse.

#[cfg(test)]
mod typescript_telemetry_tests {
    use std::sync::{Arc, Mutex};
    use tracing::{error, info, info_span, warn, Instrument};
    use tracing_subscriber::layer::SubscriberExt;

    #[derive(Debug, Clone)]
    struct CapturedLog {
        message: String,
        execution_id: Option<String>,
        trace_id: Option<String>,
    }

    struct TestCapturingLayer {
        logs: Arc<Mutex<Vec<CapturedLog>>>,
    }

    impl<S> tracing_subscriber::Layer<S> for TestCapturingLayer
    where
        S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
    {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            ctx: tracing_subscriber::layer::Context<'_, S>,
        ) {
            let mut message = String::new();
            let mut event_execution_id = None;
            let mut visitor = EventFieldVisitor {
                message: &mut message,
                execution_id: &mut event_execution_id,
            };
            event.record(&mut visitor);

            // Event-level execution_id takes precedence
            let mut execution_id = event_execution_id;
            let mut trace_id = None;

            // Also check span-level fields if event-level not found
            if execution_id.is_none() || trace_id.is_none() {
                if let Some(scope) = ctx.event_scope(event) {
                    for span in scope {
                        let extensions = span.extensions();
                        if let Some(fields) = extensions.get::<SpanFields>() {
                            if execution_id.is_none() {
                                execution_id = fields.execution_id.clone();
                            }
                            if trace_id.is_none() {
                                trace_id = fields.trace_id.clone();
                            }
                        }
                    }
                }
            }

            if let Ok(mut logs) = self.logs.lock() {
                logs.push(CapturedLog {
                    message,
                    execution_id,
                    trace_id,
                });
            }
        }

        fn on_new_span(
            &self,
            attrs: &tracing::span::Attributes<'_>,
            id: &tracing::span::Id,
            ctx: tracing_subscriber::layer::Context<'_, S>,
        ) {
            let mut fields = SpanFields::default();
            attrs.record(&mut FieldVisitor(&mut fields));

            if let Some(span) = ctx.span(id) {
                span.extensions_mut().insert(fields);
            }
        }
    }

    #[derive(Default)]
    struct SpanFields {
        execution_id: Option<String>,
        trace_id: Option<String>,
    }

    struct FieldVisitor<'a>(&'a mut SpanFields);

    impl<'a> tracing::field::Visit for FieldVisitor<'a> {
        fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
            match field.name() {
                "execution_id" => self.0.execution_id = Some(value.to_string()),
                "trace_id" => self.0.trace_id = Some(value.to_string()),
                _ => {}
            }
        }

        fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
            match field.name() {
                "execution_id" => self.0.execution_id = Some(format!("{value:?}")),
                "trace_id" => self.0.trace_id = Some(format!("{value:?}")),
                _ => {}
            }
        }
    }

    /// Visitor that captures both message and event-level execution_id
    struct EventFieldVisitor<'a> {
        message: &'a mut String,
        execution_id: &'a mut Option<String>,
    }

    impl<'a> tracing::field::Visit for EventFieldVisitor<'a> {
        fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
            match field.name() {
                "message" => *self.message = value.to_string(),
                "execution_id" => *self.execution_id = Some(value.to_string()),
                _ => {}
            }
        }

        fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
            match field.name() {
                "message" => *self.message = format!("{value:?}"),
                "execution_id" => *self.execution_id = Some(format!("{value:?}")),
                _ => {}
            }
        }
    }

    #[test]
    fn test_execution_id_propagation_in_nested_spans() {
        let logs = Arc::new(Mutex::new(Vec::new()));
        let layer = TestCapturingLayer { logs: logs.clone() };

        let subscriber = tracing_subscriber::registry().with(layer);

        tracing::subscriber::with_default(subscriber, || {
            let execution_id = "24601";
            let trace_id = "abc123def456";

            let parent_span = info_span!(
                "execute_typescript_workflow",
                execution_id = %execution_id,
                trace_id = %trace_id,
            );

            parent_span.in_scope(|| {
                info!(message = "Starting TypeScript workflow execution");
                let _nested_span = info_span!("workflow_output").entered();
                info!(message = "Step 1: Opening browser");
                info!(message = "Step 2: Navigating to URL");
            });
        });

        let captured = logs.lock().unwrap();
        assert!(
            captured.len() >= 3,
            "Expected at least 3 logs, got {}",
            captured.len()
        );

        for log in captured.iter() {
            assert_eq!(
                log.execution_id.as_deref(),
                Some("24601"),
                "Log '{}' missing execution_id",
                log.message
            );
            assert_eq!(
                log.trace_id.as_deref(),
                Some("abc123def456"),
                "Log '{}' missing trace_id",
                log.message
            );
        }
    }

    #[test]
    fn test_missing_execution_id_without_parent_span() {
        let logs = Arc::new(Mutex::new(Vec::new()));
        let layer = TestCapturingLayer { logs: logs.clone() };

        let subscriber = tracing_subscriber::registry().with(layer);

        tracing::subscriber::with_default(subscriber, || {
            info!(message = "TypeScript workflow log without context");
        });

        let captured = logs.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert!(
            captured[0].execution_id.is_none(),
            "execution_id should be None without parent span"
        );
    }

    #[tokio::test]
    async fn test_async_span_propagation() {
        let logs = Arc::new(Mutex::new(Vec::new()));
        let layer = TestCapturingLayer { logs: logs.clone() };

        let subscriber = tracing_subscriber::registry().with(layer);
        let _guard = tracing::subscriber::set_default(subscriber);

        let execution_id = "24601";
        let trace_id = "async-trace-123";

        let parent_span = info_span!(
            "execute_typescript_workflow",
            execution_id = %execution_id,
            trace_id = %trace_id,
        );

        let handle = tokio::spawn(
            async move {
                info!(message = "Async log 1");
                info!(message = "Async log 2");
            }
            .instrument(parent_span),
        );

        handle.await.unwrap();

        let captured = logs.lock().unwrap();
        assert_eq!(captured.len(), 2, "Expected 2 async logs");

        for log in captured.iter() {
            assert_eq!(
                log.execution_id.as_deref(),
                Some("24601"),
                "Async log '{}' missing execution_id",
                log.message
            );
        }
    }

    /// Test that execution_id passed as event-level field is captured correctly
    /// This verifies the new behavior where execution_id is a structured field
    /// rather than being embedded in the message body
    #[test]
    fn test_event_level_execution_id_field() {
        let logs = Arc::new(Mutex::new(Vec::new()));
        let layer = TestCapturingLayer { logs: logs.clone() };

        let subscriber = tracing_subscriber::registry().with(layer);

        tracing::subscriber::with_default(subscriber, || {
            // Simulate the new logging pattern used in workflow_typescript.rs
            // where execution_id is passed as a structured field
            info!(
                target: "workflow.typescript",
                execution_id = %"exec-12345",
                "Step completed successfully"
            );
            warn!(
                target: "workflow.typescript",
                execution_id = %"exec-12345",
                "Warning during execution"
            );
            error!(
                target: "workflow.typescript",
                execution_id = %"exec-12345",
                "Error occurred"
            );
        });

        let captured = logs.lock().unwrap();
        assert_eq!(captured.len(), 3, "Expected 3 logs");

        for log in captured.iter() {
            // Verify execution_id is captured as structured field
            assert_eq!(
                log.execution_id.as_deref(),
                Some("exec-12345"),
                "Log '{}' should have execution_id as structured field",
                log.message
            );

            // Verify message does NOT contain [execution_id=...] prefix
            assert!(
                !log.message.contains("[execution_id="),
                "Message '{}' should NOT contain execution_id prefix in body",
                log.message
            );
        }

        // Verify specific messages
        assert!(captured[0].message.contains("Step completed"));
        assert!(captured[1].message.contains("Warning"));
        assert!(captured[2].message.contains("Error"));
    }

    /// Test that logs without execution_id work correctly
    #[test]
    fn test_log_without_execution_id() {
        let logs = Arc::new(Mutex::new(Vec::new()));
        let layer = TestCapturingLayer { logs: logs.clone() };

        let subscriber = tracing_subscriber::registry().with(layer);

        tracing::subscriber::with_default(subscriber, || {
            // Simulate logging without execution_id (when execution_id is None)
            info!(target: "workflow.typescript", "Log without execution context");
        });

        let captured = logs.lock().unwrap();
        assert_eq!(captured.len(), 1);
        assert!(
            captured[0].execution_id.is_none(),
            "execution_id should be None when not provided"
        );
        assert!(captured[0]
            .message
            .contains("Log without execution context"));
    }

    /// Test that message body is clean (no execution_id prefix)
    /// This is the key behavior change: execution_id should be in the structured
    /// field, not embedded in the message like "[execution_id=XXX] message"
    #[test]
    fn test_message_body_is_clean() {
        let logs = Arc::new(Mutex::new(Vec::new()));
        let layer = TestCapturingLayer { logs: logs.clone() };

        let subscriber = tracing_subscriber::registry().with(layer);

        tracing::subscriber::with_default(subscriber, || {
            // The message should be clean, with execution_id as a separate field
            info!(
                target: "workflow.typescript",
                execution_id = %"99999",
                "Browser navigation completed"
            );
        });

        let captured = logs.lock().unwrap();
        assert_eq!(captured.len(), 1);

        let log = &captured[0];

        // The message should be exactly "Browser navigation completed"
        // NOT "[execution_id=99999] Browser navigation completed"
        assert_eq!(
            log.message, "Browser navigation completed",
            "Message should be clean without execution_id prefix"
        );

        // But execution_id should still be available as structured field
        assert_eq!(log.execution_id.as_deref(), Some("99999"));
    }
}
