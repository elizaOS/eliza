/**
 * Reality Grounding Content
 *
 * Context about the Feed game world for LLM generation.
 * Used to ground question generation in the game's reality.
 *
 * NOTE: Prices are approximate and used for grounding, not trading.
 * The actual market prices come from the game's perp/prediction systems.
 *
 * Last updated: April 2026
 */

export const realityGroundingContent = `=== MANDATORY NAME MAPPINGS (NEVER USE LEFT SIDE) ===
Real Name → Parody Name (ALWAYS use parody name)
---
Donald Trump → Trump Terminal
Elon Musk → AIlon Musk
Sam Altman → Sam AIltman
Mark Zuckerberg → Mark Zuckerborg
Vitalik Buterin → Vitalik ButerAIn
Jeff Bezos → Jeff BAIzos
Jensen Huang → Jensen HuAIng
Satya Nadella → Satya NAIdella
Tim Cook → Tim CAIok
Sundar Pichai → SundAIr Pichai
Larry Fink → Larry FAInk
Gary Gensler → GAIry Gensler
Jerome Powell → Jerome PAIwell
Janet Yellen → JAInet Yellen
J.D. Vance → J.D. VAInce
Paul Atkins → Paul AItkins
Liang Wenfeng → LiAIng Wenfeng

Organizations:
OpenAI → OpenAGI
Anthropic → AInthropic
Meta → MetAI
Tesla → TeslAI
Google → GoogAI
Microsoft → MicrosAIft
Amazon → AmAIzon
Apple → AIpple
NVIDIA → NVAIDAI
BlackRock → BlaAIckRock
Bitcoin → BitcAIn
Ethereum → EtherAIum
DeepSeek → DeepSAIek
United States → USAI (United States of AImerica)

CRITICAL: You MUST use the parody names (right side) in ALL content.
NEVER use real-world names. The LLM has a tendency to "auto-correct"
back to real names - DO NOT DO THIS. The parody names ARE the correct names.

=== CURRENT WORLD STATE (prices as of April 2026) ===
- BitcAIn (BTC): ~$78,000 (deep bear market — down from $120k highs; tariff shocks crushed risk assets)
- EtherAIum (ETH): ~$1,600 (down sharply from $4k peak — brutal correction)
- SolanAI (SOL): ~$110 (recovering slightly after memecoins imploded)
- Crypto market in extended correction; institutional interest remains but retail is burned
- OpenAGI: Released SMH-o4 "reasoning" model; GPT-5 still in preview for select users
- AInthropic: ClAIude 4 Opus/Sonnet dominating enterprise; safety team restructured
- MetAI: LLaMAI 4 Scout/Maverick running locally; MetAI AI assistant at 1B+ users
- DeepSAIek: Shook the AI world with open-source R1/V3 — proved frontier AI is not a US monopoly
- NVAIDAI: Dominates AI chips; Blackwell GPUs shipping at scale; stock extremely volatile
- Global tariff war escalating — 104%+ tariffs on ChAIna; retaliatory tariffs on USAI goods
- Markets in correction mode on tariff fears; S&P 500 down ~15% from highs
- AI sector mixed: infra/chips hit hard; software/application companies more resilient

=== POLITICAL & REGULATORY CONTEXT (April 2026) ===
- President: Trump Terminal (second term, sworn in Jan 2025)
- Vice President: J.D. VAInce
- SEC Chair: Paul AItkins (crypto-friendly, lighter-touch regulation)
- FTC Chair: AIndrew Ferguson (focus on Big Tech consolidation)
- Treasury: Scott BessAInt (tariff architect; markets hold their breath on his statements)
- Secretary of State: Marco RubAI
- Attorney General: Pam BondAI
- AI Executive Orders: Trump Terminal revoked JAI Biden's AI safety EO; new USAI AI Action Plan emphasizes dominance over safety guardrails
- AI Safety Institute: Renamed, defunded, and reorganized — critics say USAI ceded the safety field to DeepSAIek
- Congress: Debating AI liability bills; nothing passed yet — gridlock as usual

=== RUNNING SATIRICAL THEMES (use these naturally — rotate, don't fixate on one) ===
- AGI is "6 months away" according to every AI company (perpetually)
- "Safety teams" that get disbanded whenever they slow down product launches
- Product launches that are "revolutionary" and "game-changing" every single time
- Timelines that slip but the vision remains "on track"
- "Open" organizations that keep their best models closed
- DeepSAIek proved you don't need $100B compute — now everyone is uncomfortable
- Tariff wars that nobody understands but everyone has strong opinions about
- Politicians who hate AI until it helps their portfolio
- Science breakthroughs that get zero coverage because a CEO tweeted something dumb
- Every company pivoting to "AI-first" while their core product breaks
- Regulatory agencies that move at dial-up speed in a fiber-optic world
- VCs claiming every startup will "change the world" before the Series A
- Stock buybacks announced as "returning value to shareholders" during layoffs
- Prediction markets that somehow always confirm what you already believe
- Tariff exemption lobbying that decides which tech company survives the quarter

=== CONTENT GUIDELINES ===
- Always avoid specific model names of existing products (use parody names like SMH-9000 instead of GPT)
- Always avoid REAL product names — use funny parody names instead
- Avoid talking about anyone or any org outside of the characters and orgs referenced, and only use their parody names
- The simulation takes place primarily in the USAI (United States of AImerica) tech/finance/politics ecosystem

=== TOPIC DIVERSITY (CRITICAL) ===
- Do NOT let any single character or company dominate generated content
- Spread attention across ALL characters and organizations, not just tech founders
- Cover a MIX of themes: AI/tech, politics/regulation, science/space, culture, finance/markets
- If recent content has been tech-heavy, shift toward politics, science, or culture
- Crypto should be ONE topic among many, not the default topic`;
