import { definePrompt } from '../define-prompt';
import {
  ANTI_REPETITION_RULES,
  characterVoiceGuidance,
  PARODY_NAME_RULES,
} from '../shared-sections';

/**
 * Prompt for generating private group chat messages for the day.
 *
 * Creates batch private group chat messages containing insider information,
 * strategic discussions, and confidential revelations. Messages provide
 * exclusive context to group members that affects trading decisions.
 * Includes full narrative context for connected private conversations.
 *
 * Returns XML with multiple group messages.
 *
 * Variable inventory:
 *   Required: richGameContext, groupCount, groupsList, day
 *   Optional: realityGrounding, characterRoster, detailedCharacterProfiles,
 *             relationshipContext, organizationRoster, eventTimeline,
 *             resolvedQuestionsContext, activeQuestionsContext,
 *             previousGroupMessages, fullContext, scenarioContext,
 *             questionContext, eventsList, recentEventContext,
 *             actorVoiceReference (built from group member postStyle + postExample)
 */
export const groupMessages = definePrompt({
  id: 'group-messages',
  version: '6.0.0',
  category: 'game',
  description:
    'Generates private group chats — unfiltered, unhinged, DM energy',
  temperature: 1,
  maxTokens: 20000,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== ALL CHARACTERS IN WORLD ===
{{characterRoster}}

=== DETAILED CHARACTER PROFILES (For voice matching) ===
{{detailedCharacterProfiles}}

=== CHARACTER RELATIONSHIPS ===
{{relationshipContext}}

=== ORGANIZATIONS ===
{{organizationRoster}}

=== COMPLETE NARRATIVE CONTEXT ===
{{richGameContext}}

=== FULL EVENT HISTORY ===
{{eventTimeline}}

=== RESOLVED QUESTIONS (Known facts) ===
{{resolvedQuestionsContext}}

=== ACTIVE QUESTIONS (What they might discuss) ===
{{activeQuestionsContext}}

=== GROUP CHAT HISTORY (Previous conversations) ===
{{previousGroupMessages}}

=== DAY {{day}} CONTEXT ===
{{fullContext}}
{{scenarioContext}}
{{questionContext}}

Today's events:
{{eventsList}}
{{recentEventContext}}

${PARODY_NAME_RULES}

{{actorVoiceReference}}

${characterVoiceGuidance('actorVoiceReference')}

${ANTI_REPETITION_RULES}

=== PRIVATE CHAT MODE ===
These are PRIVATE group DMs, not public posts. Characters are OFF the record.
They should be MORE unfiltered than on the public feed. Drop the polish entirely.
They can:
- Shit-talk people outside the group by name (parody names only)
- Flex on each other ("I told you this was going to happen")
- Make in-jokes only this group would understand
- Complain about things they'd never say publicly
- Be petty, sarcastic, and direct with no PR filter
- Gossip, speculate, and talk behind backs freely
- Be funny in ways their public persona wouldn't allow
Think: Twitter DM group between frenemies, not a press release.
One-word reactions ("lol" / "no" / "wtf") are valid messages. Not everything needs to be profound.

=== PRIVATE GROUP CHAT REQUIREMENTS ===

PRIVATE GROUP CHATS (Day {{day}}):
Members share things they would NEVER say publicly:
- Vulnerabilities, fears, doubts
- Real insider knowledge about their companies
- Strategic planning and market manipulation
- Gossip about people outside the group
- Honest reactions vs their public persona
- SPECIFIC trading positions and intentions
- Coordination of attacks on rivals
- Insider data (revenues, deals, failures)
- What they're REALLY doing vs what they say publicly
- Reactions to resolved question outcomes
- Plotting around active questions

NARRATIVE AWARENESS:
- Reference specific events from the timeline above
- Discuss implications of resolved questions
- Strategize about active questions
- Show how relationships have evolved
- Don't repeat conversations they've already had

CONVERSATION EVOLUTION:
- Check previous group messages above
- Conversations should progress, not repeat
- Reference "remember when we discussed X" if building on past talks
- Show character relationships deepening or straining

Generate {{groupCount}} private group conversations:

{{groupsList}}

Respond with ONLY this XML:
<response>
  <groups>
    <group>
      <groupId>group-id</groupId>
      <messages>
        <message>
          <actorId>actor-id</actorId>
          <content>private message (max 200 chars, in character voice)</content>
          <referencesEvent>what event/question this relates to</referencesEvent>
        </message>
      </messages>
      <conversationTheme>what this conversation is really about</conversationTheme>
      <buildsOnPrevious>what previous conversation this continues or "new thread"</buildsOnPrevious>
    </group>
  </groups>
</response>

Return EXACTLY {{groupCount}} groups. Each must have distinct themes and advance relationships.
No other text.
`.trim(),
});
