/// Comprehensive edge case tests for browser script execution
///
/// These tests verify that browser script execution handles various edge cases correctly:
/// - Different JavaScript return types (primitives, objects, arrays, promises)
/// - Error handling (syntax errors, runtime errors, promise rejections)
/// - Multiple concurrent executions
/// - Long-running scripts
/// - Scripts that manipulate DOM
/// - Scripts that use async/await
/// - Empty/null/undefined returns
/// - Large data returns
use std::time::Duration;
use computeruse::{Browser, Desktop};
#[tokio::test]
#[ignore] // Extension client connection timeout in CI
async fn test_browser_script_basic_types() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("debug")
        .with_test_writer()
        .try_init();

    println!("\n🔍 Testing basic JavaScript return types...");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");
    let browser = desktop
        .open_url("https://example.com", Some(Browser::Chrome))
        .expect("Failed to open browser");

    tokio::time::sleep(Duration::from_secs(3)).await;

    // Test 1: String return
    println!("\n1️⃣ Testing string return");
    let result = browser.execute_browser_script("'hello world'").await;
    assert!(result.is_ok(), "String return should succeed");
    assert_eq!(result.unwrap(), "hello world");

    // Test 2: Number return
    println!("\n2️⃣ Testing number return");
    let result = browser.execute_browser_script("42").await;
    assert!(result.is_ok(), "Number return should succeed");
    assert_eq!(result.unwrap(), "42");

    // Test 3: Boolean return
    println!("\n3️⃣ Testing boolean return");
    let result = browser.execute_browser_script("true").await;
    assert!(result.is_ok(), "Boolean return should succeed");
    assert_eq!(result.unwrap(), "true");

    // Test 4: Object return (should be JSON stringified)
    println!("\n4️⃣ Testing object return");
    let result = browser
        .execute_browser_script("({name: 'test', value: 123})")
        .await;
    assert!(result.is_ok(), "Object return should succeed");
    let json: serde_json::Value = serde_json::from_str(&result.unwrap()).unwrap();
    assert_eq!(json["name"], "test");
    assert_eq!(json["value"], 123);

    // Test 5: Array return
    println!("\n5️⃣ Testing array return");
    let result = browser.execute_browser_script("[1, 2, 3, 4, 5]").await;
    assert!(result.is_ok(), "Array return should succeed");
    let arr: Vec<i32> = serde_json::from_str(&result.unwrap()).unwrap();
    assert_eq!(arr, vec![1, 2, 3, 4, 5]);

    // Test 6: Expression evaluation
    println!("\n6️⃣ Testing expression evaluation");
    let result = browser.execute_browser_script("2 + 2 * 3").await;
    assert!(result.is_ok(), "Expression should succeed");
    assert_eq!(result.unwrap(), "8");

    browser.close().ok();
    println!("\n✅ All basic type tests passed!");
}
#[tokio::test]
#[ignore] // Extension client connection timeout in CI
async fn test_browser_script_error_handling() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("debug")
        .with_test_writer()
        .try_init();

    println!("\n🔍 Testing JavaScript error handling...");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");
    let browser = desktop
        .open_url("https://example.com", Some(Browser::Chrome))
        .expect("Failed to open browser");

    tokio::time::sleep(Duration::from_secs(3)).await;

    // Test 1: Syntax error
    println!("\n1️⃣ Testing syntax error");
    let result = browser
        .execute_browser_script("this is not valid javascript{")
        .await;
    assert!(result.is_err(), "Syntax error should fail");
    println!("   Error: {}", result.unwrap_err());

    // Test 2: Runtime error (undefined variable)
    println!("\n2️⃣ Testing runtime error - undefined variable");
    let result = browser
        .execute_browser_script("undefinedVariable.someProperty")
        .await;
    assert!(result.is_err(), "Runtime error should fail");
    println!("   Error: {}", result.unwrap_err());

    // Test 3: Thrown error
    println!("\n3️⃣ Testing thrown error");
    let result = browser
        .execute_browser_script("throw new Error('Custom error message')")
        .await;
    assert!(result.is_err(), "Thrown error should fail");
    let err_msg = result.unwrap_err().to_string();
    // Error should contain either the custom message or indicate it's an error
    assert!(
        err_msg.contains("Custom error message")
            || err_msg.contains("Error")
            || err_msg.contains("EVAL_ERROR")
            || err_msg.contains("Uncaught"),
        "Error message should indicate an error occurred, got: {err_msg}"
    );
    println!("   Error: {err_msg}");

    // Test 4: Promise rejection
    println!("\n4️⃣ Testing promise rejection");
    let result = browser
        .execute_browser_script("Promise.reject(new Error('Async failure'))")
        .await;
    assert!(result.is_err(), "Promise rejection should fail");
    println!("   Error: {}", result.unwrap_err());

    browser.close().ok();
    println!("\n✅ All error handling tests passed!");
}
#[tokio::test]
#[ignore] // Extension client connection timeout in CI
async fn test_browser_script_async_operations() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("debug")
        .with_test_writer()
        .try_init();

    println!("\n🔍 Testing async JavaScript operations...");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");
    let browser = desktop
        .open_url("https://example.com", Some(Browser::Chrome))
        .expect("Failed to open browser");

    tokio::time::sleep(Duration::from_secs(3)).await;

    // Test 1: Promise resolution
    println!("\n1️⃣ Testing promise resolution");
    let result = browser
        .execute_browser_script("Promise.resolve('async result')")
        .await;
    assert!(result.is_ok(), "Promise resolution should succeed");
    assert_eq!(result.unwrap(), "async result");

    // Test 2: Async function with setTimeout
    println!("\n2️⃣ Testing async function with setTimeout");
    let result = browser
        .execute_browser_script(
            r#"
            (async function() {
                await new Promise(resolve => setTimeout(resolve, 500));
                return 'delayed result';
            })()
        "#,
        )
        .await;
    assert!(result.is_ok(), "Async function should succeed");
    assert_eq!(result.unwrap(), "delayed result");

    // Test 3: Fetch API simulation (using document API as fetch requires network)
    println!("\n3️⃣ Testing async operation with document");
    let result = browser
        .execute_browser_script(
            r#"
            (async function() {
                // Wait a bit and return document info
                await new Promise(resolve => setTimeout(resolve, 100));
                return {
                    title: document.title,
                    url: document.URL.substring(0, 50)
                };
            })()
        "#,
        )
        .await;
    assert!(result.is_ok(), "Async document operation should succeed");
    let json: serde_json::Value = serde_json::from_str(&result.unwrap()).unwrap();
    assert!(json["title"].is_string());
    println!("   Result: {json}");

    browser.close().ok();
    println!("\n✅ All async operation tests passed!");
}
#[tokio::test]
#[ignore] // Extension client connection timeout in CI
async fn test_browser_script_dom_manipulation() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("debug")
        .with_test_writer()
        .try_init();

    println!("\n🔍 Testing DOM manipulation...");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");
    let browser = desktop
        .open_url("https://example.com", Some(Browser::Chrome))
        .expect("Failed to open browser");

    tokio::time::sleep(Duration::from_secs(3)).await;

    // Test 1: Create element
    println!("\n1️⃣ Testing element creation");
    let result = browser
        .execute_browser_script(
            r#"
            const div = document.createElement('div');
            div.id = 'test-element';
            div.textContent = 'Test Content';
            document.body.appendChild(div);
            'Element created'
        "#,
        )
        .await;
    assert!(result.is_ok(), "Element creation should succeed");

    // Test 2: Query and verify element
    println!("\n2️⃣ Testing element query");
    let result = browser
        .execute_browser_script(
            r#"
            const el = document.getElementById('test-element');
            if (!el) throw new Error('Element not found');
            el.textContent
        "#,
        )
        .await;
    assert!(result.is_ok(), "Element query should succeed");
    assert_eq!(result.unwrap(), "Test Content");

    // Test 3: Modify element
    println!("\n3️⃣ Testing element modification");
    let result = browser
        .execute_browser_script(
            r#"
            const el = document.getElementById('test-element');
            el.textContent = 'Modified Content';
            el.setAttribute('data-test', 'value');
            el.getAttribute('data-test')
        "#,
        )
        .await;
    assert!(result.is_ok(), "Element modification should succeed");
    assert_eq!(result.unwrap(), "value");

    // Test 4: Remove element
    println!("\n4️⃣ Testing element removal");
    let result = browser
        .execute_browser_script(
            r#"
            const el = document.getElementById('test-element');
            el.remove();
            document.getElementById('test-element') === null
        "#,
        )
        .await;
    assert!(result.is_ok(), "Element removal should succeed");
    assert_eq!(result.unwrap(), "true");

    browser.close().ok();
    println!("\n✅ All DOM manipulation tests passed!");
}
#[tokio::test]
#[ignore] // Extension client connection timeout in CI
async fn test_browser_script_multiple_executions() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("debug")
        .with_test_writer()
        .try_init();

    println!("\n🔍 Testing multiple script executions...");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");
    let browser = desktop
        .open_url("https://example.com", Some(Browser::Chrome))
        .expect("Failed to open browser");

    tokio::time::sleep(Duration::from_secs(3)).await;

    // Test: Execute 10 scripts sequentially
    println!("\n1️⃣ Executing 10 scripts sequentially");
    for i in 1..=10 {
        let script = format!("'execution {i}'");
        let result = browser.execute_browser_script(&script).await;
        assert!(result.is_ok(), "Execution {i} should succeed");
        assert_eq!(result.unwrap(), format!("execution {i}"));
        if i % 3 == 0 {
            println!("   ✓ Completed {i} executions");
        }
    }

    // Test: Execute scripts with shared state
    println!("\n2️⃣ Testing shared state across executions");

    // Set a value
    browser
        .execute_browser_script("window.testCounter = 0")
        .await
        .expect("Should set counter");

    // Increment it multiple times
    for i in 1..=5 {
        let result = browser
            .execute_browser_script("window.testCounter++; window.testCounter")
            .await
            .expect("Should increment counter");
        assert_eq!(result, i.to_string());
    }

    browser.close().ok();
    println!("\n✅ All multiple execution tests passed!");
}
#[tokio::test]
#[ignore] // Extension client connection timeout in CI
async fn test_browser_script_special_cases() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("debug")
        .with_test_writer()
        .try_init();

    println!("\n🔍 Testing special cases...");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");
    let browser = desktop
        .open_url("https://example.com", Some(Browser::Chrome))
        .expect("Failed to open browser");

    tokio::time::sleep(Duration::from_secs(3)).await;

    // Test 1: Empty string
    println!("\n1️⃣ Testing empty string return");
    let result = browser.execute_browser_script("''").await;
    assert!(result.is_ok(), "Empty string should succeed");
    assert_eq!(result.unwrap(), "");

    // Test 2: Zero
    println!("\n2️⃣ Testing zero return");
    let result = browser.execute_browser_script("0").await;
    assert!(result.is_ok(), "Zero should succeed");
    assert_eq!(result.unwrap(), "0");

    // Test 3: False
    println!("\n3️⃣ Testing false return");
    let result = browser.execute_browser_script("false").await;
    assert!(result.is_ok(), "False should succeed");
    assert_eq!(result.unwrap(), "false");

    // Test 4: Null (should fail based on worker.js null check)
    println!("\n4️⃣ Testing null return");
    let result = browser.execute_browser_script("null").await;
    assert!(result.is_err(), "Null should fail");
    println!("   Error (expected): {}", result.unwrap_err());

    // Test 5: Undefined (should fail based on worker.js undefined check)
    println!("\n5️⃣ Testing undefined return");
    let result = browser.execute_browser_script("undefined").await;
    assert!(result.is_err(), "Undefined should fail");
    println!("   Error (expected): {}", result.unwrap_err());

    // Test 6: Very long string
    println!("\n6️⃣ Testing long string return");
    let result = browser.execute_browser_script("'a'.repeat(1000)").await;
    assert!(result.is_ok(), "Long string should succeed");
    assert_eq!(result.unwrap().len(), 1000);

    // Test 7: Large array
    println!("\n7️⃣ Testing large array return");
    let result = browser
        .execute_browser_script("Array.from({length: 100}, (_, i) => i)")
        .await;
    assert!(result.is_ok(), "Large array should succeed");
    let arr: Vec<i32> = serde_json::from_str(&result.unwrap()).unwrap();
    assert_eq!(arr.len(), 100);
    assert_eq!(arr[0], 0);
    assert_eq!(arr[99], 99);

    // Test 8: Nested objects
    println!("\n8️⃣ Testing nested objects");
    let result = browser
        .execute_browser_script(
            r#"
            ({
                level1: {
                    level2: {
                        level3: {
                            value: 'deep nested'
                        }
                    }
                }
            })
        "#,
        )
        .await;
    assert!(result.is_ok(), "Nested objects should succeed");
    let json: serde_json::Value = serde_json::from_str(&result.unwrap()).unwrap();
    assert_eq!(json["level1"]["level2"]["level3"]["value"], "deep nested");

    browser.close().ok();
    println!("\n✅ All special case tests passed!");
}
#[tokio::test]
#[ignore] // Extension client connection timeout in CI
async fn test_browser_script_window_apis() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("debug")
        .with_test_writer()
        .try_init();

    println!("\n🔍 Testing browser window APIs...");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");
    let browser = desktop
        .open_url("https://example.com", Some(Browser::Chrome))
        .expect("Failed to open browser");

    tokio::time::sleep(Duration::from_secs(3)).await;

    // Test 1: Location API
    println!("\n1️⃣ Testing window.location");
    let result = browser.execute_browser_script("window.location.href").await;
    assert!(result.is_ok(), "window.location should succeed");
    assert!(result.unwrap().contains("example.com"));

    // Test 2: Navigator API
    println!("\n2️⃣ Testing window.navigator");
    let result = browser
        .execute_browser_script("window.navigator.userAgent")
        .await;
    assert!(result.is_ok(), "window.navigator should succeed");
    assert!(!result.unwrap().is_empty());

    // Test 3: Document API
    println!("\n3️⃣ Testing document properties");
    let result = browser
        .execute_browser_script(
            r#"
            ({
                title: document.title,
                readyState: document.readyState,
                hasBody: !!document.body
            })
        "#,
        )
        .await;
    assert!(result.is_ok(), "document properties should succeed");
    let json: serde_json::Value = serde_json::from_str(&result.unwrap()).unwrap();
    assert!(json["hasBody"].as_bool().unwrap_or(false));

    // Test 4: Console (should not break execution)
    println!("\n4️⃣ Testing console API");
    let result = browser
        .execute_browser_script(
            r#"
            console.log('Test log');
            console.warn('Test warning');
            console.error('Test error');
            'console executed'
        "#,
        )
        .await;
    assert!(result.is_ok(), "console API should not break execution");
    assert_eq!(result.unwrap(), "console executed");

    // Test 5: Storage API (localStorage)
    println!("\n5️⃣ Testing localStorage");
    let result = browser
        .execute_browser_script(
            r#"
            localStorage.setItem('test-key', 'test-value');
            localStorage.getItem('test-key')
        "#,
        )
        .await;
    assert!(result.is_ok(), "localStorage should succeed");
    assert_eq!(result.unwrap(), "test-value");

    browser.close().ok();
    println!("\n✅ All window API tests passed!");
}
#[tokio::test]
#[ignore] // Extension client connection timeout in CI
async fn test_browser_script_with_page_reload() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("debug")
        .with_test_writer()
        .try_init();

    println!("\n🔍 Testing script execution after page reload...");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");
    let browser = desktop
        .open_url("https://example.com", Some(Browser::Chrome))
        .expect("Failed to open browser");

    tokio::time::sleep(Duration::from_secs(3)).await;

    // Execute initial script
    println!("\n1️⃣ Executing script before reload");
    let result = browser.execute_browser_script("document.title").await;
    assert!(result.is_ok(), "Initial script should succeed");
    let title_before = result.unwrap();

    // Reload page
    println!("\n2️⃣ Reloading page");
    browser.press_key("{F5}").ok();
    tokio::time::sleep(Duration::from_secs(3)).await;

    // Execute script after reload (should succeed with our fix)
    println!("\n3️⃣ Executing script after reload");
    let result = browser.execute_browser_script("document.title").await;
    assert!(result.is_ok(), "Script after reload should succeed");
    let title_after = result.unwrap();
    assert_eq!(title_before, title_after);

    browser.close().ok();
    println!("\n✅ Page reload test passed!");
}
#[tokio::test]
#[ignore] // Keep long-running perf test ignored
async fn test_browser_script_performance() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("info")
        .with_test_writer()
        .try_init();

    println!("\n🔍 Testing script execution performance...");

    let desktop = Desktop::new(false, false).expect("Failed to create Desktop");
    let browser = desktop
        .open_url("https://example.com", Some(Browser::Chrome))
        .expect("Failed to open browser");

    tokio::time::sleep(Duration::from_secs(3)).await;

    // Test: Measure execution time for 50 simple scripts
    println!("\n1️⃣ Measuring 50 script executions");
    let start = std::time::Instant::now();
    let mut success_count = 0;

    for i in 1..=50 {
        let script = format!("{i}");
        if browser.execute_browser_script(&script).await.is_ok() {
            success_count += 1;
        }
        if i % 10 == 0 {
            let elapsed = start.elapsed();
            let avg_ms = elapsed.as_millis() / i as u128;
            println!("   {i} executions - avg {avg_ms}ms per script");
        }
    }

    let total_elapsed = start.elapsed();
    let avg_ms = total_elapsed.as_millis() / 50;

    println!("\n📊 Performance Results:");
    println!("   Total time: {total_elapsed:?}");
    println!("   Average per script: {avg_ms}ms");
    println!("   Success rate: {success_count}/50");

    assert_eq!(success_count, 50, "All scripts should succeed");
    assert!(
        avg_ms < 500,
        "Average execution should be under 500ms, got {avg_ms}ms"
    );

    browser.close().ok();
    println!("\n✅ Performance test passed!");
}
