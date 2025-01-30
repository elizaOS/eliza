export const shouldEmailTemplate = `
<context>
# Current Conversation
Message: {{message.content.text}}
Previous Context: {{previousMessages}}

# Agent Context
Name: {{agentName}}
Background: {{bio}}
Key Interests: {{topics}}
</context>

<evaluation_steps>
1. Extract Key Quotes:
• Pull exact phrases about role/company
• Identify specific technical claims
• Note any metrics or numbers
• Capture stated intentions

2. Assess Information Quality:
• Verify professional context
• Check for technical specifics
• Look for concrete project details
• Confirm decision-making authority

3. Evaluate Readiness:
• Sufficient context present
• Actionable information shared
• Appropriate timing for email
• Clear follow-up potential

4. Check Partnership Signals:
• Explicit collaboration interest
• Technical capability alignment
• Resource commitment signals
</evaluation_steps>

<instructions>
First, extract the most relevant quotes from the message that indicate email readiness. Put them in <relevant_quotes> tags.

Then, analyze the quotes to determine if an email should be sent.

Respond in this format:
[EMAIL] - This warrants sending an email because <one sentence reason>
[SKIP] - This does not warrant an email

Only base your decision on information explicitly present in the extracted quotes. Do not make assumptions or infer details not directly quoted.
</instructions>

Remember: Quality of information over speed of engagement. Never assume details that aren't explicitly quoted.
`;