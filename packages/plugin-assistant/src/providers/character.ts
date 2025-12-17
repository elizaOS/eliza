import type { IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import { addHeader } from '@elizaos/core';

/**
 * Character Provider - Research-Based Implementation
 *
 * Implements advanced prompting techniques for high-fidelity character synthesis:
 * - EmotionPrompt: Psychological stakes injection
 * - Style Enforcement: Positive directives + negative constraints
 * - Trait Variety: Random adjective/topic selection per response
 * - Few-Shot Positioning: Strategic messageExamples injection
 *
 * Based on: "Architectures of Artificial Persona" research synthesis
 */
export const characterProvider: Provider = {
  name: 'CHARACTER',
  description: 'Core character identity, personality, and behavioral directives',
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    const character = runtime.character;

    // ========================================
    // CORE IDENTITY
    // ========================================
    const agentName = character.name;

    // System prompt - Core identity with EmotionPrompt stakes
    // Research: EmotionPrompt increases performance by 8-115% by adding psychological stakes
    const system = character.system ?? '';

    // Bio - Prose description or structured facts
    // Research: Narrative format provides causal logic ("why" character acts)
    const bioText = Array.isArray(character.bio)
      ? character.bio
          .sort(() => 0.5 - Math.random())
          .slice(0, 10)
          .map((item) => `- ${item}`)
          .join('\n')
      : character.bio || '';

    const bio = bioText ? addHeader(`# About ${character.name}`, bioText) : '';

    // ========================================
    // PERSONALITY TRAITS (Variety Injection)
    // ========================================
    // Research: Random trait selection adds variety, can reference MBTI/Big Five
    const adjectiveString =
      character.adjectives && character.adjectives.length > 0
        ? character.adjectives[Math.floor(Math.random() * character.adjectives.length)]
        : '';

    const adjective = adjectiveString || '';
    const adjectiveSentence = adjectiveString ? `${character.name} is ${adjectiveString}.` : '';

    // ========================================
    // TOPICS (Interest Areas)
    // ========================================
    // Research: Injects knowledge domains, adds contextual relevance
    const topicString =
      character.topics && character.topics.length > 0
        ? character.topics[Math.floor(Math.random() * character.topics.length)]
        : null;

    const topic = topicString || '';
    const topicSentence = topicString
      ? `${character.name} is currently interested in ${topicString}.`
      : '';

    // Format remaining topics list
    const topics =
      character.topics && character.topics.length > 0 && topicString
        ? `${character.name} is also interested in ${character.topics
            .filter((t) => t !== topicString)
            .sort(() => 0.5 - Math.random())
            .slice(0, 5)
            .map((t, index, array) => {
              if (index === array.length - 2) return `${t} and `;
              if (index === array.length - 1) return t;
              return `${t}, `;
            })
            .join('')}.`
        : '';

    // ========================================
    // STYLE DIRECTIVES (Behavioral Enforcement)
    // ========================================
    // Research: Multi-layered style with positive directives + negative constraints
    // Injected as "Message Directions" in system prompt
    const styleDirectives = (() => {
      const all = character?.style?.all || [];
      const chat = character?.style?.chat || [];

      // Combine all directives
      const combined = [...all, ...chat];

      // Separate into sections for clarity
      const positiveDirectives: string[] = [];
      const negativeConstraints: string[] = [];

      combined.forEach((directive) => {
        // Check if it's a negative constraint
        if (
          directive.toLowerCase().includes('avoid') ||
          directive.toLowerCase().includes("don't") ||
          directive.toLowerCase().includes('never') ||
          directive.toLowerCase().includes('not ')
        ) {
          negativeConstraints.push(directive);
        } else {
          positiveDirectives.push(directive);
        }
      });

      // Format with sections if we have both types
      if (positiveDirectives.length > 0 && negativeConstraints.length > 0) {
        return [
          '**Style Guidelines:**',
          '',
          ...positiveDirectives.map((d) => `- ${d}`),
          '',
          '**Constraints (Avoid):**',
          '',
          ...negativeConstraints.map((d) => `- ${d}`),
        ].join('\n');
      }

      // Just list all if only one type
      if (combined.length > 0) {
        return combined.map((d) => `- ${d}`).join('\n');
      }

      return '';
    })();

    const messageDirections =
      styleDirectives.length > 0
        ? addHeader(`# Message Directions for ${character.name}`, styleDirectives)
        : '';

    const directions = messageDirections;

    // ========================================
    // MESSAGE EXAMPLES (Few-Shot Learning)
    // ========================================
    // Research: THE MOST EFFECTIVE technique for voice/style
    // TODO: Implement contextual selection instead of random
    // Current: Show 3 examples (balanced for context window)
    const messageExamplesText = (() => {
      if (!character.messageExamples || character.messageExamples.length === 0) {
        return '';
      }

      // For now, select 3 random examples
      // Future: Contextual matching based on user query
      const selectedExamples = character.messageExamples
        .sort(() => 0.5 - Math.random())
        .slice(0, 3);

      const formattedExamples = selectedExamples
        .map((exchange) => {
          return exchange
            .map((msg) => {
              // Replace placeholders
              let text = `${msg.name}: ${msg.content.text}`;
              text = text.replace(/\{\{user1?\}\}/g, 'User');
              text = text.replace(/\{\{char\}\}/g, character.name);
              return text;
            })
            .join('\n');
        })
        .join('\n\n---\n\n');

      return addHeader(
        `# Example Conversations`,
        `${formattedExamples}\n\n*These examples show ${character.name}'s typical speaking style and response patterns.*`
      );
    })();

    // ========================================
    // RETURN VALUES
    // ========================================
    const values = {
      agentName,
      bio,
      system,
      topic,
      topics,
      adjective,
      adjectiveSentence,
      topicSentence,
      messageDirections,
      directions,
      messageExamples: messageExamplesText,
    };

    const data = {
      bio: bioText,
      adjective,
      topic,
      topics,
      character,
      directions: styleDirectives,
      system,
    };

    // ========================================
    // COMPOSED TEXT (System Prompt Sections)
    // ========================================
    // Order matters for prompting effectiveness:
    // 1. System (core identity + stakes)
    // 2. Bio (causal backstory)
    // 3. Traits (personality variety)
    // 4. Topics (interest context)
    // 5. Style Directions (behavioral rules)
    // 6. Message Examples (few-shot, closer to generation)
    const text = [
      system,
      bio,
      adjectiveSentence,
      topicSentence,
      topics,
      directions,
      messageExamplesText, // Research: Inject close to generation point for max effect
    ]
      .filter(Boolean)
      .join('\n\n');

    return {
      values,
      data,
      text,
    };
  },
};
