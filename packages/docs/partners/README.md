---
title: About
slug: /about
---

# Partners Documentation

This directory contains documentation for Eliza's partners. Each partner has their own subdirectory with an `index.md` file.

## Adding a New Partner

There are two ways to add a new partner:

### 1. Using the Script (Recommended)

Run the partner page creation script:

```bash
cd packages/docs
node scripts/create-partner-page.js
```

Follow the prompts to enter the partner's information. The script will create a new directory and `index.md` file for the partner.

### 2. Manual Creation

1. Create a new directory for the partner using their slug (lowercase, hyphenated name)
2. Create an `index.md` file inside the directory
3. Use the `_template.md` file as a reference for the structure
4. Update the `partners.tsx` file to include the new partner

## Updating Existing Partner Pages

To update all existing partner pages to use the markdown-friendly format:

```bash
cd packages/docs
node scripts/update-partner-pages.js
```

This script will:

- Preserve the existing content and frontmatter
- Add the partner logo at the top
- Format the title and links consistently
- Skip pages that already have the new format

## Partner Page Structure

Each partner page should include:

- Frontmatter with metadata (title, description, image, etc.)
- Partner logo
- Partner name and links (website, Twitter)
- Brief description
- About section
- Key features
- Integration with Eliza

## Updating Partner Information

To update a partner's information:

1. Edit the partner's `index.md` file
2. Update the corresponding entry in `partners.tsx` if necessary

## Image Guidelines

- Partner logos should be placed in `/static/img/partners/`
- Recommended size: 400x400 pixels
- Format: JPG, PNG, or WebP
- File naming: Use a descriptive name that includes the partner's name
