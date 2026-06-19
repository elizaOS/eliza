import { definePrompt } from "../define-prompt";

/**
 * Prompt providing phase-specific narrative instructions for content generation.
 *
 * Defines narrative instructions for each game phase (Wild, Escalation, Resolution).
 * Used as context to guide content generation based on which phase the game
 * is currently in. Temperature 0 as it's instructional, not generative.
 *
 * Returns phase context instructions.
 */
export const phaseContext = definePrompt({
  id: "phase-context",
  version: "2.0.0",
  category: "game",
  description:
    "Provides phase-specific narrative instructions for content generation",
  temperature: 0,
  maxTokens: 0,
  template: `
# Phase Context Helper

This file defines narrative instructions for each game phase:

## WILD PHASE (Days 1-10)
- Generate mysterious, disconnected events
- Drop vague hints and rumors
- Create speculation and uncertainty
- Events feel random and chaotic
- Minimal concrete information

## CONNECTION PHASE (Days 11-20)
- Begin connecting previous events
- Reveal relationships between actors
- Provide more concrete information
- Story threads start emerging
- Patterns become visible

## CONVERGENCE PHASE (Days 21-25)
- Major storyline convergence
- Big revelations about questions
- Clear narrative threads
- Dramatic developments
- Truth starts emerging

## CLIMAX PHASE (Days 26-29)
- Maximum drama and uncertainty
- Conflicting final clues
- Rapid developments
- High stakes moments
- Resolution seems imminent

## RESOLUTION (Day 30)
- Definitive outcomes
- All questions resolved
- Epilogue content
- Narrative closure
`.trim(),
});
