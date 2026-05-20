import { definePrompt } from '../define-prompt';
import { PARODY_NAME_RULES } from '../shared-sections';

/**
 * Prompt for generating a single satirical group chat name.
 *
 * Creates a funny, satirical name for a private group chat based on
 * the admin/creator and group purpose. Names should be humorous and
 * reflect the group's character or purpose. Includes existing group
 * names to ensure uniqueness.
 *
 * Returns XML with group chat name.
 */
export const groupChatName = definePrompt({
  id: 'group-chat-names',
  version: '3.0.0',
  category: 'game',
  description: 'Generates unique satirical group chat names',
  temperature: 0.9,
  maxTokens: 600,
  template: `{{realityGrounding}}

=== EXISTING GROUP NAMES (DON'T DUPLICATE) ===
{{existingGroupNames}}

=== ONGOING NARRATIVES (Reference if relevant) ===
{{ongoingNarratives}}

${PARODY_NAME_RULES}

Generate a UNIQUE, funny, satirical group chat name for this private group.

ADMIN (group creator): {{adminName}}
- Role: {{adminRole}}
- Domain: {{domain}}
- Affiliations: {{adminAffiliations}}

MEMBERS:
{{memberDescriptions}}

The group chat name should:
1. Be satirical and darkly funny (like "silicon valley trauma support" or "ponzi schemers united")
2. Reference the domain ({{domain}}) or the members' shared context
3. Feel like an inside joke between these specific people
4. Be 2-6 words long
5. Use lowercase
6. Be something these wealthy, powerful, slightly dysfunctional people would ironically name their private chat

Examples for inspiration (but make it unique to THIS group):
- "billionaire brunch club"
- "regulatory capture squad"
- "metaverse disasters anonymous"
- "crypto widows & orphans"

Return ONLY this XML:
<response>
  <name>the group chat name here</name>
</response>

No other text.
`.trim(),
});
