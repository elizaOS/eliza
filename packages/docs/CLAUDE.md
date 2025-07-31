# Mintlify documentation

## Working relationship
- You can push back on ideas-this can lead to better documentation. Cite sources and explain your reasoning when you do so
- ALWAYS ask for clarification rather than making assumptions
- NEVER lie, guess, or make up information

## Project context
- Format: MDX files with YAML frontmatter
- Config: docs.json for navigation, theme, settings
- Components: Mintlify components (Callouts, Cards, Tabs, Steps, etc.)

## Content strategy
- Document just enough for user success - not too much, not too little
- Prioritize accuracy and usability of information
- Make content evergreen when possible
- Search for existing information before adding new content. Avoid duplication unless it is done for a strategic reason
- Check existing patterns for consistency
- Start by making the smallest reasonable changes
- Use progressive disclosure: basic concepts before advanced ones
- Lead with the most important information (inverted pyramid structure)
- Provide multiple pathways when appropriate (beginner vs advanced), but offer an opinionated path to avoid overwhelming users

## Frontmatter requirements for pages
- title: Clear, descriptive page title
- description: Concise summary for SEO/navigation (appears under the title)
- Do NOT include an H1 heading (`# Title`) in the content if using frontmatter title - Mintlify automatically creates the H1 from frontmatter
- Optional fields: icon, iconType, mode, tag, public, deprecated

## MDX syntax standards
- Code blocks MUST have language tags (e.g., ```javascript not just ```)
- Code blocks can include meta options: title, icon, lines, highlight, focus
- Import components at the top of the file after frontmatter
- Use Mintlify components for better user experience:
  - `<Note>` for supplementary information
  - `<Tip>` for best practices and pro tips
  - `<Warning>` for critical cautions
  - `<Info>` for neutral context
  - `<Check>` for success confirmations
  - `<Tabs>` and `<Tab>` for tabbed content
  - `<Steps>` and `<Step>` for sequential instructions
  - `<Card>` for actionable links with icons
  - `<Accordion>` for collapsible content

## Writing standards
- Second-person voice ("you")
- Active voice over passive voice
- Present tense for current states, future tense for outcomes
- Prerequisites at start of procedural content
- Test all code examples before publishing
- Match style and formatting of existing pages
- Include both basic and advanced use cases
- Language tags on all code blocks
- Alt text on all images
- Relative paths for internal links
- Keep sentences concise while providing necessary context
- Use Mintlify icons instead of emojis for better consistency
- Use parallel structure in lists, headings, and procedures
- Include expected outcomes for each major step
- End sections with next steps or related information
- Use descriptive, keyword-rich headings for navigation and SEO

## Link standards
- Use relative paths for all internal documentation links
- Start paths from the root directory (e.g., `/components/cards` not `../components/cards`)
- Verify link targets exist before creating links
- Check for broken links when moving or renaming files
- Always double-check all links are valid and point to existing resources
- External links should open in same tab unless there's a specific reason not to
- Avoid deep linking to specific sections unless necessary

## Code examples
- All code examples must be complete and functional
- Include necessary imports and setup code
- Add comments to explain complex logic
- Show both basic and advanced usage patterns
- Format code consistently with project standards
- Use realistic variable and function names
- Test code in appropriate environment before documenting

## Navigation principles
- Group related content logically
- Use clear, descriptive page and section titles
- Maintain consistent hierarchy depth
- Add new pages to docs.json navigation immediately
- Consider user journey when organizing content
- Use tabs for major topic divisions
- Keep navigation labels concise but descriptive

## Git workflow
- NEVER use --no-verify when committing
- Ask how to handle uncommitted changes before starting
- Create a new branch when no clear branch exists for changes
- Commit frequently throughout development
- NEVER skip or disable pre-commit hooks
- Write clear, descriptive commit messages
- Include context in commit messages when making significant changes

## Quality checks before publishing
- Verify all links work correctly
- Test all code examples
- Check for proper MDX syntax
- Ensure frontmatter is complete and accurate
- Preview changes locally when possible
- Run any available linting or validation tools
- Review for consistency with existing documentation

## Do not
- Skip frontmatter on any MDX file
- Use absolute URLs for internal links
- Include untested code examples
- Make assumptions - always ask for clarification
- Create double headers by adding H1 (`# Title`) when frontmatter title exists
- Use HTML entities for characters - use plain text
- Create overly nested navigation structures
- Mix different documentation styles on the same page
- Use generic page titles or descriptions
- Forget to update navigation when adding new pages
- Use emojis - always prefer Mintlify icons for consistent visual presentation