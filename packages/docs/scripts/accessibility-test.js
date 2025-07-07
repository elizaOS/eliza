const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

class AccessibilityTestSuite {
  constructor() {
    this.browser = null;
    this.results = {
      timestamp: new Date().toISOString(),
      overallScore: 0,
      totalViolations: 0,
      tests: [],
      summary: {
        critical: 0,
        serious: 0,
        moderate: 0,
        minor: 0,
      },
    };

    this.testPages = [
      { name: 'Homepage', url: 'http://localhost:3002' },
      { name: 'Documentation Home', url: 'http://localhost:3002/docs' },
      { name: 'Simple Track', url: 'http://localhost:3002/docs/simple' },
      { name: 'API Reference', url: 'http://localhost:3002/api' },
      { name: 'QA Testing Page', url: 'http://localhost:3002/qa-testing' },
    ];
  }

  async runAllTests() {
    console.log('♿ Starting accessibility test suite (WCAG 2.1 AA)...\n');

    try {
      this.browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      for (const testPage of this.testPages) {
        console.log(`🔍 Testing ${testPage.name} for accessibility...`);
        await this.testPageAccessibility(testPage);
      }

      this.calculateOverallScore();
      this.generateReport();
    } catch (error) {
      console.error('❌ Accessibility test failed:', error);
      throw error;
    } finally {
      if (this.browser) {
        await this.browser.close();
      }
    }
  }

  async testPageAccessibility(testPage) {
    const page = await this.browser.newPage();

    try {
      await page.goto(testPage.url, { waitUntil: 'networkidle0', timeout: 30000 });

      // Inject axe-core for accessibility testing
      await page.addScriptTag({
        url: 'https://unpkg.com/axe-core@4.8.2/axe.min.js',
      });

      // Run comprehensive accessibility tests
      const axeResults = await page.evaluate(() => {
        return new Promise((resolve) => {
          window.axe.run(
            {
              tags: ['wcag2a', 'wcag2aa', 'wcag21aa'],
              rules: {
                'color-contrast': { enabled: true },
                'keyboard-navigation': { enabled: true },
                'focus-order-semantics': { enabled: true },
                'aria-valid-attr': { enabled: true },
                'aria-required-attr': { enabled: true },
                'landmark-one-main': { enabled: true },
                'page-has-heading-one': { enabled: true },
                bypass: { enabled: true },
                'image-alt': { enabled: true },
                label: { enabled: true },
                'link-name': { enabled: true },
                'button-name': { enabled: true },
              },
            },
            (err, results) => {
              if (err) {
                resolve({ error: err.message });
              } else {
                resolve(results);
              }
            }
          );
        });
      });

      // Run custom accessibility tests
      const customTests = await this.runCustomAccessibilityTests(page);

      const pageResult = {
        name: testPage.name,
        url: testPage.url,
        axeResults,
        customTests,
        violations: axeResults.violations || [],
        violationCount: axeResults.violations ? axeResults.violations.length : 0,
        score: this.calculatePageScore(axeResults, customTests),
      };

      this.results.tests.push(pageResult);
      this.updateSummary(axeResults.violations || []);

      console.log(
        `  ${pageResult.score >= 90 ? '✅' : pageResult.score >= 70 ? '⚠️' : '❌'} ${testPage.name}: ${pageResult.score}/100 (${pageResult.violationCount} violations)`
      );
    } catch (error) {
      console.log(`  ❌ ${testPage.name}: Failed - ${error.message}`);
      this.results.tests.push({
        name: testPage.name,
        url: testPage.url,
        error: error.message,
        score: 0,
        violationCount: 0,
      });
    } finally {
      await page.close();
    }
  }

  async runCustomAccessibilityTests(page) {
    const tests = [];

    try {
      // Test 1: Keyboard Navigation
      const keyboardNavigation = await page.evaluate(() => {
        const focusableElements = document.querySelectorAll(
          'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );

        let issues = [];

        focusableElements.forEach((element, index) => {
          // Check if element is visible
          const rect = element.getBoundingClientRect();
          const isVisible = rect.width > 0 && rect.height > 0;

          if (isVisible) {
            // Check for focus indicators
            const computedStyle = window.getComputedStyle(element, ':focus');
            const hasOutline = computedStyle.outline !== 'none' && computedStyle.outline !== '';
            const hasBoxShadow = computedStyle.boxShadow !== 'none';
            const hasBorder = computedStyle.border !== 'none';

            if (!hasOutline && !hasBoxShadow && !hasBorder) {
              issues.push(
                `Element ${element.tagName} at index ${index} lacks visible focus indicator`
              );
            }
          }
        });

        return {
          total: focusableElements.length,
          issues: issues,
          passed: issues.length === 0,
        };
      });

      tests.push({
        name: 'Keyboard Navigation',
        category: 'Navigation',
        result: keyboardNavigation,
        score: keyboardNavigation.passed
          ? 100
          : Math.max(0, 100 - keyboardNavigation.issues.length * 10),
      });

      // Test 2: Color Contrast
      const colorContrast = await page.evaluate(() => {
        const elements = document.querySelectorAll('*');
        let contrastIssues = [];

        for (let element of elements) {
          const text = element.textContent?.trim();
          if (text && text.length > 0) {
            const computedStyle = window.getComputedStyle(element);
            const color = computedStyle.color;
            const backgroundColor = computedStyle.backgroundColor;

            // Simple contrast check (would need more sophisticated algorithm in real implementation)
            if (
              color === backgroundColor ||
              (color === 'rgb(0, 0, 0)' && backgroundColor === 'rgba(0, 0, 0, 0)')
            ) {
              contrastIssues.push(`Potential contrast issue in ${element.tagName}`);
            }
          }
        }

        return {
          issues: contrastIssues.slice(0, 5), // Limit to first 5 issues
          passed: contrastIssues.length === 0,
        };
      });

      tests.push({
        name: 'Color Contrast',
        category: 'Visual',
        result: colorContrast,
        score: colorContrast.passed ? 100 : Math.max(0, 100 - colorContrast.issues.length * 15),
      });

      // Test 3: Alternative Text
      const altText = await page.evaluate(() => {
        const images = document.querySelectorAll('img');
        let issues = [];

        images.forEach((img, index) => {
          if (!img.alt && !img.getAttribute('aria-label') && !img.getAttribute('aria-labelledby')) {
            issues.push(`Image ${index + 1} missing alternative text`);
          } else if (img.alt && img.alt.length > 150) {
            issues.push(
              `Image ${index + 1} has overly long alt text (${img.alt.length} characters)`
            );
          }
        });

        return {
          totalImages: images.length,
          issues: issues,
          passed: issues.length === 0,
        };
      });

      tests.push({
        name: 'Alternative Text',
        category: 'Content',
        result: altText,
        score: altText.passed ? 100 : Math.max(0, 100 - altText.issues.length * 20),
      });

      // Test 4: Semantic Structure
      const semanticStructure = await page.evaluate(() => {
        const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
        const landmarks = document.querySelectorAll(
          'main, nav, aside, section, article, header, footer'
        );
        let issues = [];

        // Check heading hierarchy
        let previousLevel = 0;
        headings.forEach((heading, index) => {
          const level = parseInt(heading.tagName.charAt(1));
          if (index === 0 && level !== 1) {
            issues.push('Page should start with h1 heading');
          }
          if (level > previousLevel + 1) {
            issues.push(`Heading level ${level} skips hierarchy after h${previousLevel}`);
          }
          previousLevel = level;
        });

        // Check for main landmark
        const mainElements = document.querySelectorAll('main');
        if (mainElements.length === 0) {
          issues.push('Page missing main landmark');
        } else if (mainElements.length > 1) {
          issues.push('Page has multiple main landmarks');
        }

        return {
          headingCount: headings.length,
          landmarkCount: landmarks.length,
          issues: issues,
          passed: issues.length === 0,
        };
      });

      tests.push({
        name: 'Semantic Structure',
        category: 'Structure',
        result: semanticStructure,
        score: semanticStructure.passed
          ? 100
          : Math.max(0, 100 - semanticStructure.issues.length * 15),
      });

      // Test 5: Form Accessibility
      const formAccessibility = await page.evaluate(() => {
        const formElements = document.querySelectorAll('input, select, textarea');
        let issues = [];

        formElements.forEach((element, index) => {
          // Check for labels
          const hasLabel = element.labels && element.labels.length > 0;
          const hasAriaLabel = element.getAttribute('aria-label');
          const hasAriaLabelledby = element.getAttribute('aria-labelledby');
          const hasPlaceholder = element.placeholder;

          if (!hasLabel && !hasAriaLabel && !hasAriaLabelledby) {
            if (!hasPlaceholder || element.type === 'submit' || element.type === 'button') {
              issues.push(`Form element ${index + 1} (${element.type}) missing accessible label`);
            }
          }

          // Check for required field indicators
          if (element.required && !element.getAttribute('aria-required')) {
            issues.push(`Required form element ${index + 1} missing aria-required attribute`);
          }
        });

        return {
          totalFormElements: formElements.length,
          issues: issues,
          passed: issues.length === 0,
        };
      });

      tests.push({
        name: 'Form Accessibility',
        category: 'Forms',
        result: formAccessibility,
        score: formAccessibility.passed
          ? 100
          : Math.max(0, 100 - formAccessibility.issues.length * 25),
      });
    } catch (error) {
      console.error('Error running custom accessibility tests:', error);
    }

    return tests;
  }

  calculatePageScore(axeResults, customTests) {
    if (axeResults.error) {
      return 0;
    }

    let score = 100;

    // Deduct points for axe violations
    if (axeResults.violations) {
      axeResults.violations.forEach((violation) => {
        switch (violation.impact) {
          case 'critical':
            score -= 25;
            break;
          case 'serious':
            score -= 15;
            break;
          case 'moderate':
            score -= 10;
            break;
          case 'minor':
            score -= 5;
            break;
        }
      });
    }

    // Factor in custom test scores
    if (customTests && customTests.length > 0) {
      const customScore =
        customTests.reduce((sum, test) => sum + test.score, 0) / customTests.length;
      score = score * 0.6 + customScore * 0.4; // Weight axe results more heavily
    }

    return Math.max(0, Math.round(score));
  }

  updateSummary(violations) {
    violations.forEach((violation) => {
      this.results.totalViolations++;
      switch (violation.impact) {
        case 'critical':
          this.results.summary.critical++;
          break;
        case 'serious':
          this.results.summary.serious++;
          break;
        case 'moderate':
          this.results.summary.moderate++;
          break;
        case 'minor':
          this.results.summary.minor++;
          break;
      }
    });
  }

  calculateOverallScore() {
    const validTests = this.results.tests.filter((test) => !test.error);
    if (validTests.length === 0) {
      this.results.overallScore = 0;
      return;
    }

    const totalScore = validTests.reduce((sum, test) => sum + test.score, 0);
    this.results.overallScore = Math.round(totalScore / validTests.length);
  }

  generateReport() {
    console.log('\n♿ Accessibility Test Report (WCAG 2.1 AA)');
    console.log('='.repeat(60));
    console.log(`Overall Score: ${this.results.overallScore}/100`);
    console.log(`Total Violations: ${this.results.totalViolations}`);

    // Show violation breakdown
    console.log('\n📊 Violation Summary:');
    console.log(`  🔴 Critical: ${this.results.summary.critical}`);
    console.log(`  🟠 Serious: ${this.results.summary.serious}`);
    console.log(`  🟡 Moderate: ${this.results.summary.moderate}`);
    console.log(`  🔵 Minor: ${this.results.summary.minor}`);

    // Show page scores
    console.log('\n📄 Page Accessibility Scores:');
    this.results.tests.forEach((test) => {
      if (test.error) {
        console.log(`  ❌ ${test.name}: ERROR - ${test.error}`);
      } else {
        const icon = test.score >= 90 ? '✅' : test.score >= 70 ? '⚠️' : '❌';
        console.log(
          `  ${icon} ${test.name}: ${test.score}/100 (${test.violationCount} violations)`
        );
      }
    });

    // Show critical violations
    const criticalViolations = this.results.tests
      .filter((test) => test.violations)
      .flatMap((test) =>
        test.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')
      );

    if (criticalViolations.length > 0) {
      console.log('\n🚨 Critical & Serious Violations:');
      criticalViolations.slice(0, 10).forEach((violation, index) => {
        console.log(`\n${index + 1}. ${violation.description}`);
        console.log(`   Impact: ${violation.impact.toUpperCase()}`);
        console.log(`   Help: ${violation.helpUrl}`);
        if (violation.nodes && violation.nodes.length > 0) {
          console.log(`   Elements affected: ${violation.nodes.length}`);
          violation.nodes.slice(0, 3).forEach((node) => {
            console.log(`     • ${node.target.join(', ')}`);
          });
          if (violation.nodes.length > 3) {
            console.log(`     ... and ${violation.nodes.length - 3} more`);
          }
        }
      });

      if (criticalViolations.length > 10) {
        console.log(`\n... and ${criticalViolations.length - 10} more critical/serious violations`);
      }
    }

    // Recommendations
    console.log('\n💡 Accessibility Recommendations:');

    if (this.results.summary.critical > 0) {
      console.log('  🔴 URGENT: Fix critical accessibility violations before deployment');
    }

    if (this.results.summary.serious > 0) {
      console.log('  🟠 HIGH PRIORITY: Address serious accessibility issues');
    }

    if (this.results.overallScore < 80) {
      console.log('  📚 Consider accessibility training for the development team');
      console.log('  🔧 Implement automated accessibility testing in CI/CD pipeline');
      console.log('  👥 Conduct user testing with assistive technology users');
    }

    console.log('  ✅ Use NVDA, JAWS, or VoiceOver to manually test screen reader compatibility');
    console.log('  ⌨️  Test all functionality using only keyboard navigation');
    console.log('  🎨 Verify color contrast meets WCAG AA standards (4.5:1 ratio)');

    // Save detailed report
    const reportPath = path.join(__dirname, '..', 'accessibility-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(this.results, null, 2));
    console.log(`\n📄 Detailed report saved to: ${reportPath}`);

    // Determine exit code
    if (this.results.summary.critical > 0) {
      console.log('\n❌ Accessibility test FAILED due to critical violations');
      return 1;
    } else if (this.results.overallScore >= 80) {
      console.log('\n✅ Accessibility test PASSED with good compliance');
      return 0;
    } else {
      console.log('\n⚠️  Accessibility test passed but needs improvement');
      return 0;
    }
  }
}

// Run if called directly
if (require.main === module) {
  const testSuite = new AccessibilityTestSuite();
  testSuite
    .runAllTests()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error) => {
      console.error('❌ Accessibility test suite failed:', error);
      process.exit(1);
    });
}

module.exports = AccessibilityTestSuite;
