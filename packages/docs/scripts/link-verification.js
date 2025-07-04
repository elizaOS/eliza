const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

class LinkVerificationTool {
  constructor() {
    this.results = {
      total: 0,
      valid: 0,
      broken: 0,
      warnings: 0,
      details: [],
    };
    this.baseDir = path.join(__dirname, '..');
    this.contentDirs = ['docs', 'community', 'partners', 'packages', 'blog'];
  }

  async verifyAllLinks() {
    console.log('🔍 Starting comprehensive link verification...\n');

    for (const dir of this.contentDirs) {
      const dirPath = path.join(this.baseDir, dir);
      if (fs.existsSync(dirPath)) {
        console.log(`📁 Scanning ${dir} directory...`);
        await this.scanDirectory(dirPath, dir);
      }
    }

    this.generateReport();
  }

  async scanDirectory(dirPath, dirName) {
    const files = this.getMarkdownFiles(dirPath);

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const links = this.extractLinks(content);

      console.log(`  📄 ${file}: Found ${links.length} links`);

      for (const link of links) {
        await this.verifyLink(link, file, dirName);
      }
    }
  }

  getMarkdownFiles(dirPath) {
    const files = [];

    function scanDir(currentPath) {
      const items = fs.readdirSync(currentPath);

      for (const item of items) {
        const itemPath = path.join(currentPath, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
          scanDir(itemPath);
        } else if (stat.isFile() && (item.endsWith('.md') || item.endsWith('.mdx'))) {
          files.push(path.relative(dirPath, itemPath));
        }
      }
    }

    scanDir(dirPath);
    return files;
  }

  extractLinks(content) {
    const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
    const relativeRegex = /\[([^\]]*)\]\(([^)]+)\)/g;

    const links = new Set();

    // Markdown links
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      links.add(match[2]);
    }

    // Plain URLs
    while ((match = urlRegex.exec(content)) !== null) {
      links.add(match[0]);
    }

    return Array.from(links);
  }

  async verifyLink(link, file, directory) {
    this.results.total++;

    try {
      if (link.startsWith('http://') || link.startsWith('https://')) {
        await this.verifyExternalLink(link, file, directory);
      } else if (link.startsWith('/')) {
        this.verifyInternalLink(link, file, directory);
      } else if (link.startsWith('./') || link.startsWith('../') || !link.includes('://')) {
        this.verifyRelativeLink(link, file, directory);
      } else {
        this.addResult('warning', link, file, directory, 'Unknown link format');
      }
    } catch (error) {
      this.addResult('broken', link, file, directory, error.message);
    }
  }

  async verifyExternalLink(link, file, directory) {
    return new Promise((resolve) => {
      const isHttps = link.startsWith('https://');
      const client = isHttps ? https : http;

      const options = {
        method: 'HEAD',
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)',
        },
      };

      const req = client.request(link, options, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          this.addResult('valid', link, file, directory, `Status: ${res.statusCode}`);
        } else if (res.statusCode >= 300 && res.statusCode < 400) {
          this.addResult('warning', link, file, directory, `Redirect: ${res.statusCode}`);
        } else {
          this.addResult('broken', link, file, directory, `HTTP ${res.statusCode}`);
        }
        resolve();
      });

      req.on('error', (error) => {
        this.addResult('broken', link, file, directory, error.message);
        resolve();
      });

      req.on('timeout', () => {
        this.addResult('broken', link, file, directory, 'Request timeout');
        req.destroy();
        resolve();
      });

      req.setTimeout(10000);
      req.end();
    });
  }

  verifyInternalLink(link, file, directory) {
    // Remove query parameters and anchors
    const cleanLink = link.split('?')[0].split('#')[0];

    // Check if it's a valid internal route
    const knownRoutes = [
      '/docs',
      '/api',
      '/packages',
      '/community',
      '/partners',
      '/blog',
      '/news',
      '/docs/simple',
      '/docs/customize',
      '/docs/technical',
    ];

    const isValidRoute =
      knownRoutes.some((route) => cleanLink.startsWith(route)) ||
      cleanLink === '/' ||
      cleanLink.startsWith('/docs/') ||
      cleanLink.startsWith('/packages/') ||
      cleanLink.startsWith('/community/') ||
      cleanLink.startsWith('/api/');

    if (isValidRoute) {
      this.addResult('valid', link, file, directory, 'Valid internal route');
    } else {
      this.addResult('warning', link, file, directory, 'Unverified internal route');
    }
  }

  verifyRelativeLink(link, file, directory) {
    try {
      const filePath = path.join(this.baseDir, directory, path.dirname(file));
      const targetPath = path.resolve(filePath, link);

      if (fs.existsSync(targetPath)) {
        this.addResult('valid', link, file, directory, 'File exists');
      } else {
        // Try with common extensions
        const extensions = ['.md', '.mdx', '/index.md', '/index.mdx'];
        let found = false;

        for (const ext of extensions) {
          if (fs.existsSync(targetPath + ext)) {
            this.addResult('valid', link, file, directory, `File exists with extension ${ext}`);
            found = true;
            break;
          }
        }

        if (!found) {
          this.addResult('broken', link, file, directory, 'File not found');
        }
      }
    } catch (error) {
      this.addResult('broken', link, file, directory, error.message);
    }
  }

  addResult(status, link, file, directory, message) {
    if (status === 'valid') {
      this.results.valid++;
    } else if (status === 'broken') {
      this.results.broken++;
    } else {
      this.results.warnings++;
    }

    this.results.details.push({
      status,
      link,
      file,
      directory,
      message,
      timestamp: new Date().toISOString(),
    });
  }

  generateReport() {
    console.log('\n📊 Link Verification Report');
    console.log('='.repeat(50));
    console.log(`Total links checked: ${this.results.total}`);
    console.log(`✅ Valid links: ${this.results.valid}`);
    console.log(`⚠️  Warnings: ${this.results.warnings}`);
    console.log(`❌ Broken links: ${this.results.broken}`);

    const successRate = ((this.results.valid / this.results.total) * 100).toFixed(1);
    console.log(`📈 Success rate: ${successRate}%\n`);

    // Show broken links
    if (this.results.broken > 0) {
      console.log('❌ Broken Links:');
      this.results.details
        .filter((result) => result.status === 'broken')
        .forEach((result) => {
          console.log(`  📁 ${result.directory}/${result.file}`);
          console.log(`     🔗 ${result.link}`);
          console.log(`     💬 ${result.message}\n`);
        });
    }

    // Show warnings
    if (this.results.warnings > 0) {
      console.log('⚠️  Warnings:');
      this.results.details
        .filter((result) => result.status === 'warning')
        .slice(0, 10) // Show first 10 warnings
        .forEach((result) => {
          console.log(`  📁 ${result.directory}/${result.file}`);
          console.log(`     🔗 ${result.link}`);
          console.log(`     💬 ${result.message}\n`);
        });

      if (this.results.warnings > 10) {
        console.log(`  ... and ${this.results.warnings - 10} more warnings\n`);
      }
    }

    // Save detailed report
    const reportPath = path.join(this.baseDir, 'link-verification-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(this.results, null, 2));
    console.log(`📄 Detailed report saved to: ${reportPath}`);

    // Return exit code based on results
    if (this.results.broken > 0) {
      console.log('\n❌ Link verification failed due to broken links');
      process.exit(1);
    } else if (this.results.warnings > 5) {
      console.log('\n⚠️  Link verification completed with warnings');
      process.exit(0);
    } else {
      console.log('\n✅ Link verification passed successfully');
      process.exit(0);
    }
  }
}

// Run if called directly
if (require.main === module) {
  const verifier = new LinkVerificationTool();
  verifier.verifyAllLinks().catch((error) => {
    console.error('❌ Link verification failed:', error);
    process.exit(1);
  });
}

module.exports = LinkVerificationTool;
