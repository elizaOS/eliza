import fs from 'node:fs';

const biomePath = './biome.json';
const content = fs.readFileSync(biomePath, 'utf8');

// Replace all "off" with "warn" but only within rule definitions
const updated = content.replace(/: "off"/g, ': "warn"');

fs.writeFileSync(biomePath, updated);
console.log('Updated biome.json rules from "off" to "warn"');