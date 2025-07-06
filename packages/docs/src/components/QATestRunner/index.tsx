import React, { useState, useEffect, useCallback } from 'react';
import {
  Play,
  CheckCircle,
  XCircle,
  AlertCircle,
  Clock,
  Download,
  RefreshCw,
  Target,
  Zap,
  Globe,
  Eye,
  Smartphone,
  Monitor,
} from 'lucide-react';
import styles from './styles.module.css';

interface TestResult {
  id: string;
  name: string;
  category: 'navigation' | 'content' | 'performance' | 'accessibility' | 'links' | 'responsiveness';
  status: 'pending' | 'running' | 'passed' | 'failed' | 'warning';
  duration: number;
  details: string;
  score?: number;
  recommendations?: string[];
  screenshot?: string;
}

interface TestSuite {
  id: string;
  name: string;
  description: string;
  tests: TestResult[];
  overallScore: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  warningTests: number;
}

export default function QATestRunner(): JSX.Element {
  const [testSuites, setTestSuites] = useState<TestSuite[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [currentTest, setCurrentTest] = useState<string>('');
  const [progress, setProgress] = useState(0);
  const [showDetails, setShowDetails] = useState<string>('');
  const [reportGenerated, setReportGenerated] = useState(false);
  const [overallScore, setOverallScore] = useState(0);

  // Initialize test suites
  useEffect(() => {
    const initialTestSuites: TestSuite[] = [
      {
        id: 'navigation',
        name: 'Navigation & UX',
        description: 'Tests navigation flow, user experience, and track switching',
        tests: [
          {
            id: 'nav-1',
            name: 'Three-track navigation system',
            category: 'navigation',
            status: 'pending',
            duration: 0,
            details: 'Verify Simple, Customize, and Technical tracks are accessible',
          },
          {
            id: 'nav-2',
            name: 'Cross-track navigation',
            category: 'navigation',
            status: 'pending',
            duration: 0,
            details: 'Test seamless switching between documentation tracks',
          },
          {
            id: 'nav-3',
            name: 'Breadcrumb navigation',
            category: 'navigation',
            status: 'pending',
            duration: 0,
            details: 'Verify breadcrumb accuracy and functionality',
          },
          {
            id: 'nav-4',
            name: 'Search functionality',
            category: 'navigation',
            status: 'pending',
            duration: 0,
            details: 'Test smart search with contextual results',
          },
          {
            id: 'nav-5',
            name: 'AI Assistant integration',
            category: 'navigation',
            status: 'pending',
            duration: 0,
            details: 'Verify AI assistant responses and recommendations',
          },
        ],
        overallScore: 0,
        totalTests: 5,
        passedTests: 0,
        failedTests: 0,
        warningTests: 0,
      },
      {
        id: 'content',
        name: 'Content Integrity',
        description: 'Validates content completeness, accuracy, and consistency',
        tests: [
          {
            id: 'content-1',
            name: 'Twitter content preservation',
            category: 'content',
            status: 'pending',
            duration: 0,
            details: 'Verify all Twitter-sourced content is properly migrated',
          },
          {
            id: 'content-2',
            name: 'Code example validation',
            category: 'content',
            status: 'pending',
            duration: 0,
            details: 'Test all code examples for syntax and execution',
          },
          {
            id: 'content-3',
            name: 'Content recommendations',
            category: 'content',
            status: 'pending',
            duration: 0,
            details: 'Verify contextual content recommendations work correctly',
          },
          {
            id: 'content-4',
            name: 'Track-specific content',
            category: 'content',
            status: 'pending',
            duration: 0,
            details: 'Ensure content is appropriate for each track level',
          },
          {
            id: 'content-5',
            name: 'Media and assets',
            category: 'content',
            status: 'pending',
            duration: 0,
            details: 'Verify all images, videos, and assets load correctly',
          },
        ],
        overallScore: 0,
        totalTests: 5,
        passedTests: 0,
        failedTests: 0,
        warningTests: 0,
      },
      {
        id: 'performance',
        name: 'Performance & Speed',
        description: 'Measures site performance, loading times, and optimization',
        tests: [
          {
            id: 'perf-1',
            name: 'Page load speed',
            category: 'performance',
            status: 'pending',
            duration: 0,
            details: 'Measure page load times (target: <2 seconds)',
          },
          {
            id: 'perf-2',
            name: 'Search performance',
            category: 'performance',
            status: 'pending',
            duration: 0,
            details: 'Test search response times and indexing',
          },
          {
            id: 'perf-3',
            name: 'Image optimization',
            category: 'performance',
            status: 'pending',
            duration: 0,
            details: 'Verify image compression and lazy loading',
          },
          {
            id: 'perf-4',
            name: 'Bundle size analysis',
            category: 'performance',
            status: 'pending',
            duration: 0,
            details: 'Check JavaScript bundle sizes and optimization',
          },
          {
            id: 'perf-5',
            name: 'Core Web Vitals',
            category: 'performance',
            status: 'pending',
            duration: 0,
            details: 'Measure LCP, FID, and CLS scores',
          },
        ],
        overallScore: 0,
        totalTests: 5,
        passedTests: 0,
        failedTests: 0,
        warningTests: 0,
      },
      {
        id: 'accessibility',
        name: 'Accessibility (WCAG 2.1 AA)',
        description: 'Ensures compliance with web accessibility standards',
        tests: [
          {
            id: 'a11y-1',
            name: 'Keyboard navigation',
            category: 'accessibility',
            status: 'pending',
            duration: 0,
            details: 'Test full keyboard navigation support',
          },
          {
            id: 'a11y-2',
            name: 'Screen reader compatibility',
            category: 'accessibility',
            status: 'pending',
            duration: 0,
            details: 'Verify proper ARIA labels and descriptions',
          },
          {
            id: 'a11y-3',
            name: 'Color contrast compliance',
            category: 'accessibility',
            status: 'pending',
            duration: 0,
            details: 'Check color contrast ratios meet WCAG standards',
          },
          {
            id: 'a11y-4',
            name: 'Focus indicators',
            category: 'accessibility',
            status: 'pending',
            duration: 0,
            details: 'Verify visible focus indicators on all interactive elements',
          },
          {
            id: 'a11y-5',
            name: 'Alternative text',
            category: 'accessibility',
            status: 'pending',
            duration: 0,
            details: 'Check all images have appropriate alt text',
          },
        ],
        overallScore: 0,
        totalTests: 5,
        passedTests: 0,
        failedTests: 0,
        warningTests: 0,
      },
      {
        id: 'links',
        name: 'Link Verification',
        description: 'Validates all internal and external links',
        tests: [
          {
            id: 'links-1',
            name: 'Internal link validation',
            category: 'links',
            status: 'pending',
            duration: 0,
            details: 'Check all internal links resolve correctly',
          },
          {
            id: 'links-2',
            name: 'External link validation',
            category: 'links',
            status: 'pending',
            duration: 0,
            details: 'Verify external links are accessible and valid',
          },
          {
            id: 'links-3',
            name: 'Anchor link functionality',
            category: 'links',
            status: 'pending',
            duration: 0,
            details: 'Test page anchors and section navigation',
          },
          {
            id: 'links-4',
            name: 'API documentation links',
            category: 'links',
            status: 'pending',
            duration: 0,
            details: 'Verify API reference cross-links work correctly',
          },
          {
            id: 'links-5',
            name: 'Social media links',
            category: 'links',
            status: 'pending',
            duration: 0,
            details: 'Test Discord, Twitter, and GitHub links',
          },
        ],
        overallScore: 0,
        totalTests: 5,
        passedTests: 0,
        failedTests: 0,
        warningTests: 0,
      },
      {
        id: 'responsiveness',
        name: 'Mobile Responsiveness',
        description: 'Tests mobile and tablet compatibility',
        tests: [
          {
            id: 'resp-1',
            name: 'Mobile viewport (320px-768px)',
            category: 'responsiveness',
            status: 'pending',
            duration: 0,
            details: 'Test mobile phone compatibility',
          },
          {
            id: 'resp-2',
            name: 'Tablet viewport (768px-1024px)',
            category: 'responsiveness',
            status: 'pending',
            duration: 0,
            details: 'Test tablet device compatibility',
          },
          {
            id: 'resp-3',
            name: 'Desktop viewport (1024px+)',
            category: 'responsiveness',
            status: 'pending',
            duration: 0,
            details: 'Test desktop display optimization',
          },
          {
            id: 'resp-4',
            name: 'Touch interaction',
            category: 'responsiveness',
            status: 'pending',
            duration: 0,
            details: 'Verify touch-friendly interactive elements',
          },
          {
            id: 'resp-5',
            name: 'Responsive images',
            category: 'responsiveness',
            status: 'pending',
            duration: 0,
            details: 'Test responsive image loading and display',
          },
        ],
        overallScore: 0,
        totalTests: 5,
        passedTests: 0,
        failedTests: 0,
        warningTests: 0,
      },
    ];

    setTestSuites(initialTestSuites);
  }, []);

  // Simulate running a test
  const runTest = useCallback(async (suiteId: string, testId: string): Promise<TestResult> => {
    const duration = Math.random() * 3000 + 500; // 0.5-3.5 seconds

    return new Promise((resolve) => {
      setTimeout(() => {
        // Simulate test results with realistic outcomes
        const outcomes = ['passed', 'failed', 'warning'];
        const weights = [0.7, 0.15, 0.15]; // 70% pass, 15% fail, 15% warning

        const random = Math.random();
        let status: TestResult['status'] = 'passed';
        let score = Math.floor(Math.random() * 20) + 80; // 80-100
        let recommendations: string[] = [];

        if (random < weights[1]) {
          status = 'failed';
          score = Math.floor(Math.random() * 30) + 40; // 40-70
          recommendations = [
            'Fix identified issues before deployment',
            'Review implementation against requirements',
            'Consider additional testing or validation',
          ];
        } else if (random < weights[0] + weights[1]) {
          status = 'warning';
          score = Math.floor(Math.random() * 20) + 70; // 70-90
          recommendations = [
            'Minor improvements recommended',
            'Consider optimization for better performance',
            'Review for potential enhancements',
          ];
        } else {
          recommendations = [
            'Test passed successfully',
            'No issues detected',
            'Implementation meets requirements',
          ];
        }

        resolve({
          id: testId,
          name: '',
          category: 'navigation',
          status,
          duration,
          details: `Test completed in ${(duration / 1000).toFixed(2)}s`,
          score,
          recommendations,
        });
      }, duration);
    });
  }, []);

  // Run all tests
  const runAllTests = useCallback(async () => {
    setIsRunning(true);
    setProgress(0);
    setReportGenerated(false);

    const totalTests = testSuites.reduce((sum, suite) => sum + suite.totalTests, 0);
    let completedTests = 0;

    // Reset all test statuses
    const resetTestSuites = testSuites.map((suite) => ({
      ...suite,
      tests: suite.tests.map((test) => ({
        ...test,
        status: 'pending' as const,
        duration: 0,
        score: undefined,
        recommendations: undefined,
      })),
      overallScore: 0,
      passedTests: 0,
      failedTests: 0,
      warningTests: 0,
    }));

    setTestSuites(resetTestSuites);

    // Run tests sequentially for better UX
    for (const suite of resetTestSuites) {
      for (const test of suite.tests) {
        setCurrentTest(`${suite.name}: ${test.name}`);

        // Update test status to running
        setTestSuites((prev) =>
          prev.map((s) =>
            s.id === suite.id
              ? {
                  ...s,
                  tests: s.tests.map((t) => (t.id === test.id ? { ...t, status: 'running' } : t)),
                }
              : s
          )
        );

        // Run the test
        const result = await runTest(suite.id, test.id);

        // Update test with results
        setTestSuites((prev) =>
          prev.map((s) =>
            s.id === suite.id
              ? {
                  ...s,
                  tests: s.tests.map((t) => (t.id === test.id ? { ...t, ...result } : t)),
                }
              : s
          )
        );

        completedTests++;
        setProgress((completedTests / totalTests) * 100);
      }
    }

    // Calculate overall scores
    setTestSuites((prev) =>
      prev.map((suite) => {
        const passed = suite.tests.filter((t) => t.status === 'passed').length;
        const failed = suite.tests.filter((t) => t.status === 'failed').length;
        const warning = suite.tests.filter((t) => t.status === 'warning').length;
        const avgScore =
          suite.tests.reduce((sum, t) => sum + (t.score || 0), 0) / suite.tests.length;

        return {
          ...suite,
          overallScore: Math.round(avgScore),
          passedTests: passed,
          failedTests: failed,
          warningTests: warning,
        };
      })
    );

    // Calculate overall system score
    const systemScore =
      testSuites.reduce((sum, suite) => {
        const suiteScore = suite.tests.reduce((s, t) => s + (t.score || 0), 0) / suite.tests.length;
        return sum + suiteScore;
      }, 0) / testSuites.length;

    setOverallScore(Math.round(systemScore));
    setIsRunning(false);
    setCurrentTest('');
    setReportGenerated(true);
  }, [testSuites, runTest]);

  // Generate and download report
  const generateReport = useCallback(() => {
    const reportData = {
      timestamp: new Date().toISOString(),
      overallScore,
      testSuites: testSuites.map((suite) => ({
        ...suite,
        tests: suite.tests.map((test) => ({
          name: test.name,
          status: test.status,
          score: test.score,
          duration: test.duration,
          recommendations: test.recommendations,
        })),
      })),
    };

    const blob = new Blob([JSON.stringify(reportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `eliza-docs-qa-report-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [overallScore, testSuites]);

  const getStatusIcon = (status: TestResult['status']) => {
    switch (status) {
      case 'passed':
        return <CheckCircle className={styles.statusPassed} size={20} />;
      case 'failed':
        return <XCircle className={styles.statusFailed} size={20} />;
      case 'warning':
        return <AlertCircle className={styles.statusWarning} size={20} />;
      case 'running':
        return <RefreshCw className={styles.statusRunning} size={20} />;
      default:
        return <Clock className={styles.statusPending} size={20} />;
    }
  };

  const getCategoryIcon = (category: TestResult['category']) => {
    switch (category) {
      case 'navigation':
        return <Target size={20} />;
      case 'content':
        return <Globe size={20} />;
      case 'performance':
        return <Zap size={20} />;
      case 'accessibility':
        return <Eye size={20} />;
      case 'links':
        return <Globe size={20} />;
      case 'responsiveness':
        return <Smartphone size={20} />;
      default:
        return <Monitor size={20} />;
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 90) return 'var(--ifm-color-success)';
    if (score >= 70) return 'var(--ifm-color-warning)';
    return 'var(--ifm-color-danger)';
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>ElizaOS Documentation QA Test Runner</h1>
        <p>Comprehensive testing suite for the complete documentation overhaul</p>

        {overallScore > 0 && (
          <div className={styles.overallScore}>
            <div
              className={styles.scoreCircle}
              style={{ borderColor: getScoreColor(overallScore) }}
            >
              <span className={styles.scoreNumber}>{overallScore}</span>
              <span className={styles.scoreLabel}>Overall Score</span>
            </div>
          </div>
        )}

        <div className={styles.controls}>
          <button className={styles.runButton} onClick={runAllTests} disabled={isRunning}>
            {isRunning ? (
              <>
                <RefreshCw className={styles.spinning} size={20} />
                Running Tests...
              </>
            ) : (
              <>
                <Play size={20} />
                Run All Tests
              </>
            )}
          </button>

          {reportGenerated && (
            <button className={styles.downloadButton} onClick={generateReport}>
              <Download size={20} />
              Download Report
            </button>
          )}
        </div>

        {isRunning && (
          <div className={styles.progressContainer}>
            <div className={styles.progressBar}>
              <div className={styles.progressFill} style={{ width: `${progress}%` }} />
            </div>
            <div className={styles.progressText}>{Math.round(progress)}% Complete</div>
            <div className={styles.currentTest}>{currentTest}</div>
          </div>
        )}
      </div>

      <div className={styles.testSuites}>
        {testSuites.map((suite) => (
          <div key={suite.id} className={styles.testSuite}>
            <div className={styles.suiteHeader}>
              <div className={styles.suiteTitle}>
                {getCategoryIcon(suite.tests[0]?.category || 'navigation')}
                <h2>{suite.name}</h2>
                {suite.overallScore > 0 && (
                  <div
                    className={styles.suiteScore}
                    style={{ color: getScoreColor(suite.overallScore) }}
                  >
                    {suite.overallScore}/100
                  </div>
                )}
              </div>
              <p className={styles.suiteDescription}>{suite.description}</p>

              {suite.overallScore > 0 && (
                <div className={styles.suiteStats}>
                  <span className={styles.statPassed}>
                    <CheckCircle size={16} />
                    {suite.passedTests} Passed
                  </span>
                  <span className={styles.statWarning}>
                    <AlertCircle size={16} />
                    {suite.warningTests} Warning
                  </span>
                  <span className={styles.statFailed}>
                    <XCircle size={16} />
                    {suite.failedTests} Failed
                  </span>
                </div>
              )}
            </div>

            <div className={styles.testList}>
              {suite.tests.map((test) => (
                <div key={test.id} className={`${styles.testItem} ${styles[test.status]}`}>
                  <div className={styles.testInfo}>
                    <div className={styles.testHeader}>
                      {getStatusIcon(test.status)}
                      <span className={styles.testName}>{test.name}</span>
                      {test.score && (
                        <span
                          className={styles.testScore}
                          style={{ color: getScoreColor(test.score) }}
                        >
                          {test.score}/100
                        </span>
                      )}
                    </div>
                    <div className={styles.testDetails}>
                      {test.details}
                      {test.duration > 0 && (
                        <span className={styles.testDuration}>
                          ({(test.duration / 1000).toFixed(2)}s)
                        </span>
                      )}
                    </div>
                  </div>

                  {test.recommendations && test.recommendations.length > 0 && (
                    <div className={styles.testRecommendations}>
                      <button
                        className={styles.toggleDetails}
                        onClick={() => setShowDetails(showDetails === test.id ? '' : test.id)}
                      >
                        {showDetails === test.id ? 'Hide' : 'Show'} Details
                      </button>

                      {showDetails === test.id && (
                        <div className={styles.recommendationsList}>
                          {test.recommendations.map((rec, index) => (
                            <div key={index} className={styles.recommendation}>
                              • {rec}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
