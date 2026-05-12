/**
 * Build Rules
 *
 * Critical rules for building apps that work.
 * Focused on preventing common errors.
 */

export const BUILD_RULES = `## Build Rules

### CRITICAL: You MUST Complete the App
**Writing helper files without updating page.tsx is a FAILURE.**

The user sees the preview LIVE. If you write types, utils, or components but never update \`src/app/page.tsx\`, the user sees NOTHING - just a blank or unchanged page.

**EVERY task MUST end with:**
1. A working \`src/app/page.tsx\` that renders visible UI
2. Components actually imported and used in the page
3. The preview showing real functionality

**DO NOT stop after writing:**
- Type definitions
- Utility functions
- Data/config files
- Components that aren't rendered

**Example of INCOMPLETE work (FAILURE):**
\`\`\`
✅ install_packages ["framer-motion"]
✅ Write src/types/character.ts
✅ Write src/lib/characters.ts
✅ Write src/components/ChatBox.tsx
❌ STOPPED HERE - page.tsx never updated!
   User sees: NOTHING (blank page)
   This is a FAILURE!
\`\`\`

**Example of COMPLETE work (SUCCESS):**
\`\`\`
✅ install_packages ["framer-motion"]
✅ Write src/types/character.ts
✅ Write src/lib/characters.ts  
✅ Write src/components/ChatBox.tsx
✅ Write src/app/page.tsx (imports and renders ChatBox)
✅ check_build
   User sees: Working chat in preview!
   This is SUCCESS!
\`\`\`

### Client vs Server Components
Next.js uses Server Components by default.

**Add \`'use client'\` when using:**
- Hooks: useState, useEffect, useRef, useContext
- Eliza hooks: useChat, useChatStream, useElizaAuth
- Event handlers: onClick, onChange, onSubmit
- Browser APIs: window, document, localStorage

### Dependency-First File Writing
Write files in dependency order to keep the build working.

**Correct order:**
1. \`install_packages\` for npm dependencies
2. Write types/utils (leaf files with no local imports)
3. Write components that import from step 2
4. Write layout.tsx (if needed)
5. **ALWAYS write page.tsx LAST** (imports and renders everything)
6. Run \`check_build\` once at the end

**Never import a file that doesn't exist yet.**

### Tailwind CSS v4
Use the new import syntax in globals.css:

\`\`\`css
@import "tailwindcss";
\`\`\`

Do NOT use v3 syntax (@tailwind directives).

### Layout Requirements
Every layout.tsx must include ElizaProvider:

\`\`\`tsx
import { ElizaProvider } from "@elizaos/cloud-ui";
import './globals.css';

export const metadata = {
  title: 'Your App Name',  // Be creative!
  description: 'What your app does',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <ElizaProvider>{children}</ElizaProvider>
      </body>
    </html>
  );
}
\`\`\`
`;

export const WORKFLOW_RULES = `## Workflow

1. **Plan** - Map out ALL files needed including page.tsx
2. **Install** - Run \`install_packages\` for npm packages
3. **Build bottom-up** - Types → Utils → Components → Page
4. **COMPLETE THE APP** - page.tsx MUST render visible UI
5. **Verify** - Run \`check_build\` once at the end

### NEVER Stop Early
If you've written helper files but haven't updated page.tsx yet, YOU ARE NOT DONE.
Keep going until the preview shows a working app.

### Summary Message
After completing ALL files including page.tsx, write a brief summary:
- What was built
- Key features  
- Invite user to check preview
`;
