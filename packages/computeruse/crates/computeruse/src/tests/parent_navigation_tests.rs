//! Tests for parent navigation functionality
//!
//! This module tests the parent() method implementation across different platforms,
//! ensuring that parent-child relationships are correctly navigated in the UI tree.

use crate::{AutomationError, Desktop, UIElement};
use std::time::Duration;

/// Test fixture for parent navigation tests that ensures proper setup and cleanup
struct ParentTestFixture {
    #[allow(dead_code)]
    desktop: Desktop,
    app: Option<UIElement>,
}

impl ParentTestFixture {
    /// Creates a new test fixture with Notepad opened for reliable testing
    fn new() -> Result<Self, AutomationError> {
        let desktop = Desktop::new(false, false)?;

        // Open Notepad as a simple, reliable test application
        let app = desktop.open_application("notepad").ok();

        // Wait for the application to be ready
        std::thread::sleep(Duration::from_millis(1000));

        Ok(Self { desktop, app })
    }
}

impl Drop for ParentTestFixture {
    fn drop(&mut self) {
        // Clean up: close the application if it was opened
        if let Some(ref app) = self.app {
            let _ = app.close();
        }
        // Small delay to ensure cleanup completes
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
#[cfg(target_os = "windows")]
fn test_parent_navigation_basic() {
    println!("\n🔍 Testing basic parent navigation functionality");

    let fixture = ParentTestFixture::new().expect("Failed to create test fixture");

    if let Some(ref app) = fixture.app {
        // Find a child element (text editor area) in Notepad
        match app.children() {
            Ok(children) => {
                let mut found_valid_parent = false;

                for child in children.iter().take(5) {
                    // Test parent navigation
                    match child.parent() {
                        Ok(Some(parent)) => {
                            println!("  ✅ Found parent for child element");

                            // Verify the parent is actually different from the child
                            let child_id = child.id().unwrap_or_default();
                            let parent_id = parent.id().unwrap_or_default();

                            assert_ne!(
                                child_id, parent_id,
                                "Parent should have different ID than child"
                            );

                            // Verify parent has the child in its children list
                            if let Ok(parent_children) = parent.children() {
                                let child_found_in_parent = parent_children
                                    .iter()
                                    .any(|pc| pc.id().unwrap_or_default() == child_id);

                                if child_found_in_parent {
                                    println!(
                                        "  ✅ Verified parent-child relationship is bidirectional"
                                    );
                                    found_valid_parent = true;
                                    break;
                                }
                            }
                        }
                        Ok(None) => {
                            println!("  ℹ️  Element has no parent (might be root element)");
                        }
                        Err(e) => {
                            println!("  ⚠️  Error getting parent: {e}");
                        }
                    }
                }

                assert!(
                    found_valid_parent,
                    "Should find at least one element with a valid parent"
                );
            }
            Err(e) => panic!("Failed to get children from app: {e}"),
        }
    } else {
        panic!("Failed to open Notepad for testing");
    }
}

#[test]
#[cfg(target_os = "windows")]
fn test_parent_navigation_multi_level() {
    println!("\n🔍 Testing multi-level parent navigation (grandparents)");

    let fixture = ParentTestFixture::new().expect("Failed to create test fixture");

    if let Some(ref app) = fixture.app {
        // Find a deeply nested element
        if let Ok(children) = app.children() {
            for child in children.iter().take(3) {
                if let Ok(grandchildren) = child.children() {
                    for grandchild in grandchildren.iter().take(2) {
                        // Test parent navigation: grandchild -> child
                        match grandchild.parent() {
                            Ok(Some(parent)) => {
                                println!("  ✅ Grandchild found its parent");

                                // Test grandparent navigation: parent -> grandparent
                                match parent.parent() {
                                    Ok(Some(grandparent)) => {
                                        println!(
                                            "  ✅ Found grandparent through parent navigation"
                                        );

                                        // Verify IDs are all different
                                        let grandchild_id = grandchild.id().unwrap_or_default();
                                        let parent_id = parent.id().unwrap_or_default();
                                        let grandparent_id = grandparent.id().unwrap_or_default();

                                        assert_ne!(
                                            grandchild_id, parent_id,
                                            "Grandchild and parent should have different IDs"
                                        );
                                        assert_ne!(
                                            parent_id, grandparent_id,
                                            "Parent and grandparent should have different IDs"
                                        );
                                        assert_ne!(
                                            grandchild_id, grandparent_id,
                                            "Grandchild and grandparent should have different IDs"
                                        );

                                        println!("  ✅ Multi-level parent navigation test passed");
                                        return;
                                    }
                                    Ok(None) => {
                                        println!("  ℹ️  Parent has no parent (reached root)");
                                    }
                                    Err(e) => {
                                        println!("  ⚠️  Error getting grandparent: {e}");
                                    }
                                }
                            }
                            Ok(None) => {
                                println!("  ℹ️  Grandchild has no parent");
                            }
                            Err(e) => {
                                println!("  ⚠️  Error getting parent from grandchild: {e}");
                            }
                        }
                    }
                }
            }
        }

        println!(
            "  ℹ️  Multi-level navigation completed (may not have found deeply nested elements)"
        );
    } else {
        panic!("Failed to open Notepad for testing");
    }
}

#[test]
#[cfg(target_os = "windows")]
fn test_parent_navigation_error_handling() {
    println!("\n🔍 Testing parent navigation error handling");

    let fixture = ParentTestFixture::new().expect("Failed to create test fixture");

    if let Some(ref app) = fixture.app {
        // Test with the root application element - should handle gracefully
        match app.parent() {
            Ok(Some(_parent)) => {
                println!("  ✅ Root element has a parent (window manager or desktop)");
            }
            Ok(None) => {
                println!("  ✅ Root element correctly reports no parent");
            }
            Err(e) => {
                println!("  ✅ Parent navigation error handled gracefully: {e}");
                // This is acceptable behavior - the error should be an AutomationError::ElementNotFound
                assert!(
                    matches!(e, AutomationError::ElementNotFound(_)),
                    "Should return ElementNotFound error, got: {e:?}"
                );
            }
        }

        // Test with a child element that should have a parent
        if let Ok(children) = app.children() {
            if let Some(child) = children.first() {
                match child.parent() {
                    Ok(Some(_parent)) => {
                        println!("  ✅ Child element successfully found its parent");
                    }
                    Ok(None) => {
                        println!("  ⚠️  Child element reports no parent (unexpected)");
                    }
                    Err(e) => {
                        println!("  ⚠️  Error getting parent from child: {e}");
                        // This should generally not happen for valid child elements
                    }
                }
            }
        }
    } else {
        panic!("Failed to open Notepad for testing");
    }
}

#[test]
#[cfg(target_os = "windows")]
fn test_parent_navigation_consistency() {
    println!("\n🔍 Testing parent navigation consistency");

    let fixture = ParentTestFixture::new().expect("Failed to create test fixture");

    if let Some(ref app) = fixture.app {
        if let Ok(children) = app.children() {
            for (i, child) in children.iter().take(3).enumerate() {
                println!("  🔍 Testing child element #{}", i + 1);

                // Get parent multiple times and ensure consistency
                let parent1 = child.parent();
                let parent2 = child.parent();

                match (parent1, parent2) {
                    (Ok(Some(p1)), Ok(Some(p2))) => {
                        let id1 = p1.id().unwrap_or_default();
                        let id2 = p2.id().unwrap_or_default();

                        assert_eq!(
                            id1, id2,
                            "Multiple calls to parent() should return the same element"
                        );
                        println!("    ✅ Parent navigation is consistent");
                    }
                    (Ok(None), Ok(None)) => {
                        println!("    ✅ Consistently reports no parent");
                    }
                    (Err(_), Err(_)) => {
                        println!("    ✅ Consistently reports error");
                    }
                    _ => {
                        panic!("Inconsistent parent() results between calls");
                    }
                }
            }
        }
    } else {
        panic!("Failed to open Notepad for testing");
    }
}
