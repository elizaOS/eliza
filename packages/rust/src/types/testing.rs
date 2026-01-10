//! Testing types for elizaOS
//!
//! Contains test case and test suite types.

use serde::{Deserialize, Serialize};

/// Test case definition for serialization
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCaseDefinition {
    /// Test case name
    pub name: String,
}

/// Test suite definition for serialization
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestSuiteDefinition {
    /// Test suite name
    pub name: String,
    /// Test case definitions
    pub tests: Vec<TestCaseDefinition>,
}

/// Test suite with executable tests
pub struct TestSuite {
    /// Suite name
    pub name: String,
    /// Test cases
    pub tests: Vec<TestCase>,
}

impl TestSuite {
    /// Create a new test suite
    pub fn new(name: &str) -> Self {
        TestSuite {
            name: name.to_string(),
            tests: vec![],
        }
    }

    /// Add a test case
    pub fn add_test<F>(mut self, name: &str, test_fn: F) -> Self
    where
        F: Fn() -> Result<(), anyhow::Error> + Send + Sync + 'static,
    {
        self.tests.push(TestCase {
            name: name.to_string(),
            test_fn: Box::new(test_fn),
        });
        self
    }

    /// Get the definition for serialization
    pub fn definition(&self) -> TestSuiteDefinition {
        TestSuiteDefinition {
            name: self.name.clone(),
            tests: self
                .tests
                .iter()
                .map(|t| TestCaseDefinition {
                    name: t.name.clone(),
                })
                .collect(),
        }
    }

    /// Run all tests
    pub fn run(&self) -> TestResults {
        let mut results = TestResults {
            suite_name: self.name.clone(),
            passed: 0,
            failed: 0,
            errors: vec![],
        };

        for test in &self.tests {
            match (test.test_fn)() {
                Ok(()) => results.passed += 1,
                Err(e) => {
                    results.failed += 1;
                    results.errors.push(TestError {
                        test_name: test.name.clone(),
                        error: e.to_string(),
                    });
                }
            }
        }

        results
    }
}

/// Test case with executable function
pub struct TestCase {
    /// Test name
    pub name: String,
    /// Test function
    pub test_fn: Box<dyn Fn() -> Result<(), anyhow::Error> + Send + Sync>,
}

/// Test results
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResults {
    /// Suite name
    pub suite_name: String,
    /// Number of passed tests
    pub passed: usize,
    /// Number of failed tests
    pub failed: usize,
    /// Error details
    pub errors: Vec<TestError>,
}

impl TestResults {
    /// Check if all tests passed
    pub fn all_passed(&self) -> bool {
        self.failed == 0
    }

    /// Get total number of tests
    pub fn total(&self) -> usize {
        self.passed + self.failed
    }
}

/// Test error information
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestError {
    /// Test name
    pub test_name: String,
    /// Error message
    pub error: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_test_suite_creation() {
        let suite = TestSuite::new("Test Suite")
            .add_test("passes", || Ok(()))
            .add_test("fails", || Err(anyhow::anyhow!("Expected failure")));

        let results = suite.run();
        assert_eq!(results.passed, 1);
        assert_eq!(results.failed, 1);
        assert_eq!(results.total(), 2);
    }

    #[test]
    fn test_test_suite_definition() {
        let suite = TestSuite::new("My Suite")
            .add_test("test1", || Ok(()))
            .add_test("test2", || Ok(()));

        let def = suite.definition();
        assert_eq!(def.name, "My Suite");
        assert_eq!(def.tests.len(), 2);
    }
}
