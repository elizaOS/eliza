#!/usr/bin/env node
// index_qmd_files.js - Scan directories and index .qmd (Quarto Markdown) files
// Updates the manifest and SQLite index with file metadata

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, 'config', 'qmd_index.json');
const MANIFEST_PATH = path.join(__dirname, '.index', 'qmd_manifest.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function scanDirectory(dirPath, patterns, excludes) {
  const results = [];
  
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(dirPath, fullPath);
      
      // Check exclusions
      if (excludes.some(ex => relPath.includes(ex.replace('/**', '')))) continue;
      
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && patterns.some(p => entry.name.endsWith(p.replace('*', '')))) {
        const stat = fs.statSync(fullPath);
        const content = fs.readFileSync(fullPath, 'utf8');
        const checksum = crypto.createHash('md5').update(content).digest('hex');
        
        // Extract YAML frontmatter
        let frontmatter = {};
        const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (yamlMatch) {
          // Simple YAML parsing for title/author/date
          const lines = yamlMatch[1].split('\n');
          for (const line of lines) {
            const kv = line.match(/^(\w+):\s*(.+)/);
            if (kv) frontmatter[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
          }
        }
        
        results.push({
          path: fullPath,
          relativePath: relPath,
          filename: entry.name,
          size: stat.size,
          modifiedTime: stat.mtime.toISOString(),
          checksum,
          frontmatter,
          indexedAt: new Date().toISOString()
        });
      }
    }
  }
  
  walk(dirPath);
  return results;
}

function main() {
  const config = loadConfig();
  const allFiles = [];
  
  for (const root of config.scanRoots) {
    const files = scanDirectory(root, config.filePatterns, config.excludePatterns);
    allFiles.push(...files);
  }
  
  const manifest = {
    generatedAt: new Date().toISOString(),
    totalFiles: allFiles.length,
    scanRoots: config.scanRoots,
    files: allFiles
  };
  
  // Ensure index directory exists
  const indexDir = path.dirname(MANIFEST_PATH);
  if (!fs.existsSync(indexDir)) fs.mkdirSync(indexDir, { recursive: true });
  
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`Indexed ${allFiles.length} .qmd files`);
}

main();
