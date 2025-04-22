#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Paths
const PARTNERS_DATA_PATH = path.join(__dirname, '../src/data/partners.tsx');
const PARTNERS_DIR = path.join(__dirname, '../partners');

// Read and parse partners.tsx
function getPartnersData() {
  try {
    const content = fs.readFileSync(PARTNERS_DATA_PATH, 'utf8');
    // Extract the partners array using regex
    const match = content.match(/export const partners: PartnerType\[\] = (\[[\s\S]*?\]);/);
    if (!match) {
      throw new Error('Could not find partners data in partners.tsx');
    }

    // Evaluate the array string to get the actual data
    // Note: This is safe because we control the source file
    const partnersArray = eval(match[1]);
    return partnersArray;
  } catch (error) {
    console.error('Error reading partners data:', error.message);
    process.exit(1);
  }
}

// Generate markdown content for a partner
function generateMarkdown(partner) {
  // Use the existing preview path from the partner data
  const imagePath = partner.preview;

  // Create links section
  let linksSection = '## Links\n\n';

  // Add website and source links
  linksSection += `- [Website](${partner.website})\n`;
  linksSection += `- [Source](${partner.source})\n`;

  // Add social links if they exist
  if (partner.twitter) {
    linksSection += `- [Twitter](${partner.twitter})\n`;
  }

  if (partner.discord) {
    linksSection += `- [Discord](${partner.discord})\n`;
  }

  if (partner.telegram) {
    linksSection += `- [Telegram](${partner.telegram})\n`;
  }

  return `---
id: ${partner.slug}
title: ${partner.title}
sidebar_position: 1
description: ${partner.description}
image: ${imagePath}
website: ${partner.website}
twitter: ${partner.twitter || ''}
tags: ${JSON.stringify(partner.tags)}
hide_table_of_contents: true
---

# ${partner.title}

<div className="partner-logo">
  <img src="${imagePath}" alt="${partner.title} logo" />
</div>

${partner.description}

## About ${partner.title}

${partner.title} is a key partner in our ecosystem, providing ${partner.description.toLowerCase()}.

## Key Features

- Integration with ${partner.title}'s platform
- Seamless user experience
- Enhanced functionality through partnership

## Integration with Eliza

Our partnership with ${partner.title} enables users to access their services directly through Eliza, providing a seamless experience for all users.

${linksSection}`;
}

// Update a partner's markdown file
function updatePartnerPage(partner) {
  try {
    const partnerDir = path.join(PARTNERS_DIR, partner.slug);
    const indexPath = path.join(partnerDir, 'index.md');

    // Create partner directory if it doesn't exist
    if (!fs.existsSync(partnerDir)) {
      fs.mkdirSync(partnerDir, { recursive: true });
    }

    // Generate and write the markdown content
    const markdown = generateMarkdown(partner);
    fs.writeFileSync(indexPath, markdown);
    console.log(`Updated ${partner.slug}/index.md`);
  } catch (error) {
    console.error(`Error updating ${partner.slug}:`, error.message);
  }
}

// Main function
function main() {
  try {
    // Get partners data
    const partners = getPartnersData();
    console.log(`Found ${partners.length} partners in partners.tsx`);

    // Update each partner's page
    partners.forEach((partner) => {
      updatePartnerPage(partner);
    });

    console.log('Successfully updated all partner pages');
  } catch (error) {
    console.error('Error updating partner pages:', error.message);
    process.exit(1);
  }
}

// Run the script
main();
